/**
 * Shared plumbing for the "extra" open-access sources (Dialnet, DOAB/OAPEN, Redalyc, UPN, CLACSO ...).
 *
 *  - Rec → Publication through the server's own `sanitizePublication`, but with PER-SOURCE host
 *    allowlists (functions/security.ts is NOT touched: the orchestrator widens TRUSTED_CONTENT_HOST later).
 *  - Cheap PDF verification (Range request, first bytes == "%PDF-"), image dimensions for covers.
 *  - Country hints for Ibero-American journals/publishers, cross-source de-duplication.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sanitizePublication } from '../../../functions/publications';
import { safeHttpUrl } from '../../../functions/security';
import { classifyOecdArea, inferCountry } from '../../../src/lib/taxonomy';
import type { Publication } from '../../../src/types/publication';
import { ROOT_DIR } from '../cache';
import { fetchWithRetry, mapPool } from '../http';
import { decodeEntities, languageCode, normTitle, normalizeDoi, squash, type Rec } from '../model';
import { insertStatement, parseInsertLine, splitStatements } from '../output';

export const EXTRA_OUT_DIR = path.join(ROOT_DIR, 'scripts', 'out', 'seed-extra');

/* ------------------------------------ results ------------------------------------ */

export interface SourceReport {
  source: string;
  endpoint: string;
  /** what happened, in one or two sentences (also printed in the final report) */
  status: 'ok' | 'dropped' | 'unreachable' | 'blocked' | 'skipped';
  note: string;
  scanned?: number;
  harvested: number;
  pdfSample?: { tested: number; ok: number; rate: number; failures: string[] };
}

export interface SourceResult {
  report: SourceReport;
  records: Rec[];
  /** host regex (anchored, lower-case) the source's URLs must match */
  allow: RegExp;
  /** True when direct PDF endpoints don't always end in `.pdf` (e.g. OJS `/article/download/`), still verified by pdfPassRate. */
  allowNonExtPdf?: boolean;
  /** hosts actually used by the kept records: landing / pdf / cover */
  hosts?: { landing: Set<string>; pdf: Set<string>; cover: Set<string> };
}

/* ------------------------------------- text ------------------------------------- */

/** Plain text from OAI/HTML: tags removed, entities decoded (twice: some feeds double-encode), whitespace squashed. */
export function plain(input: unknown): string {
  if (typeof input !== 'string') return '';
  let s = input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, ' ');
  return squash(s);
}

/** Returns all `<dc:name ...>value</dc:name>` values (plain text) of an OAI record, optionally with their attrs. */
export function dcAll(xml: string, name: string): Array<{ value: string; attrs: string }> {
  const out: Array<{ value: string; attrs: string }> = [];
  const re = new RegExp(`<(?:dc|oaire|oapen|dcterms|datacite):${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:dc|oaire|oapen|dcterms|datacite):${name}>)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const value = plain(m[2] ?? '');
    if (value) out.push({ value, attrs: m[1] || '' });
  }
  return out;
}

export function yearOf(raw: string | undefined): number | null {
  const m = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(raw || '');
  return m ? Number(m[1]) : null;
}

/** ISO 639-2/3 and 639-1 → the codes the catalog stores. Unknown stays '' (→ 'other'), never defaulted. */
export function langFromIso(raw: string | undefined): string {
  const l = (raw || '').trim().toLowerCase();
  if (!l) return '';
  if (/^(spa|es|esl|es-|spanish|español|castellano)/.test(l)) return 'es';
  if (/^(por|pt|pt-|portuguese|portugu)/.test(l)) return 'pt';
  if (/^(eng|en|en-|english|ingl)/.test(l)) return 'en';
  return l.slice(0, 3);
}

/* ------------------------------------ country ------------------------------------ */

/** Words in journal / publisher / institution strings that identify the country (checked in order). */
const COUNTRY_TEXT: Array<[RegExp, string]> = [
  [/colombia|bogot[aá]|medell[ií]n|\bcali\b|barranquilla|cartagena de indias|bucaramanga|tunja|manizales|pereira|popay[aá]n|pasto\b|univ(?:ersidad)?\.? (?:de )?(?:antioquia|nacional de colombia|del valle|industrial de santander|javeriana|del rosario|externado|de los andes|del norte|de caldas|de cartagena|del cauca|de nari[nñ]o|pedag[oó]gica|libre|santo tom[aá]s|la sabana|cooperativa de colombia|eafit|de la salle|surcolombiana|tecnol[oó]gica de pereira|distrital)|\buptc\b|icfes|minciencias|colciencias/i, 'Colombia'],
  [/m[eé]xico|\bunam\b|guadalajara|monterrey|puebla|veracruz|yucat[aá]n|hidalgo|sonora|chihuahua|nuevo le[oó]n|tamaulipas|baja california|uaem|\buam\b|cinvestav|colegio de la frontera|colegio de m[eé]xico|\bipn\b/i, 'México'],
  [/argentin|buenos aires|c[oó]rdoba, arg|rosario, arg|la plata|mendoza|tucum[aá]n|santa fe, arg|\bconicet\b|\buba\b|\bunlp\b|\bunc\b|universidad nacional de (?:la plata|c[oó]rdoba|cuyo|rosario|tucum[aá]n|general sarmiento|quilmes|mar del plata|entre r[ií]os|la pampa|salta|luj[aá]n|san juan|del sur)/i, 'Argentina'],
  [/\bchile|santiago de chile|valpara[ií]so|concepci[oó]n, chile|temuco|universidad de chile|cat[oó]lica de chile|universidad austral de chile/i, 'Chile'],
  [/per[uú]\b|lima, per|cusco|arequipa|trujillo, per|pucp|san marcos|universidad nacional (?:mayor de san marcos|san antonio abad)/i, 'Perú'],
  [/venezuela|caracas|maracaibo|m[eé]rida, ven|\bula\b|\bucv\b|universidad (?:central de venezuela|de los andes)/i, 'Venezuela'],
  [/ecuador|quito|guayaquil|cuenca, ecu|\bflacso ecuador|universidad (?:andina sim[oó]n bol[ií]var|central del ecuador)/i, 'Ecuador'],
  [/uruguay|montevideo|universidad de la rep[uú]blica/i, 'Uruguay'],
  [/bolivia|la paz, bol|cochabamba|sucre, bol|universidad mayor de san/i, 'Bolivia'],
  [/paraguay|asunci[oó]n/i, 'Paraguay'],
  [/costa rica|san jos[eé], costa|\bucr\b|universidad (?:de costa rica|nacional, costa)/i, 'Costa Rica'],
  [/\bcuba\b|la habana|habana|universidad de la habana|santiago de cuba|camag[uü]ey|holgu[ií]n|villa clara/i, 'Cuba'],
  [/brasil|brazil|s[aã]o paulo|rio de janeiro|minas gerais|porto alegre|bras[ií]lia|curitiba|salvador, bahia|\buni(?:versidade)? (?:federal|estadual|de s[aã]o paulo)|\bufrgs\b|\bufmg\b|\busp\b|\bunesp\b|\bunicamp\b|\bufsc\b|\bufpr\b/i, 'Brasil'],
  [/portugal|lisboa|porto, port|coimbra|minho|universidade (?:de lisboa|do porto|de coimbra|do minho|nova de lisboa)/i, 'Portugal'],
  [/espa[nñ]a|spain|madrid|barcelona|sevilla|granada|valencia|salamanca|zaragoza|m[aá]laga|murcia|oviedo|santiago de compostela|bilbao|pamplona|navarra|pa[ií]s vasco|euskal|catalu[nñ]a|andaluc[ií]a|galicia|canarias|la laguna|la rioja|logro[nñ]o|valladolid|alicante|castell[oó]n|c[aá]diz|c[oó]rdoba, esp|universitat|universidade de (?:vigo|santiago|a coru)|\buned\b|\bcsic\b|\bucm\b|\bupv\b|\bupc\b|\bupm\b|\buam, madrid|ministerio de (?:educaci[oó]n|ciencia|cultura)|complutense|\bcervantes\b|real academia|consejo superior de investigaciones|universidad (?:de )?(?:la laguna|de granada|de sevilla|de valencia|de murcia|de oviedo|de le[oó]n|de zaragoza|de burgos|de c[oó]rdoba|de ja[eé]n|de almer[ií]a|de huelva|de c[aá]diz|de extremadura|de cantabria|del pa[ií]s vasco|de navarra|de alcal[aá]|de alicante|de castilla|rey juan carlos|carlos iii|pablo de olavide|polit[eé]cnica de (?:madrid|valencia|catalu[nñ]a))|ediciones (?:morata|narcea|akal|aljibe|octaedro|paid[oó]s)|\bfundaci[oó]n (?:alternativas|dialnet)/i, 'España']
];

/** Country from free text (journal title, publisher, imprint ...). null when there is no evidence. */
export function countryFromText(...texts: Array<string | undefined | null>): string | null {
  const t = texts.filter(Boolean).join(' | ');
  if (!t) return null;
  for (const [re, country] of COUNTRY_TEXT) if (re.test(t)) return country;
  return null;
}

/** Extra-source country: free-text evidence + the project's own inferCountry (ISBN groups, hosts, publishers). */
export function countryOf(r: Rec, extraText: string[] = []): string {
  const hint = countryFromText(...extraText, r.journal, r.publisher);
  return inferCountry({
    country: hint,
    collection: r.collection,
    collectionCode: r.collectionCode,
    scieloUrl: r.scieloUrl,
    pdfUrl: r.pdfUrl,
    publisher: r.publisher,
    isbn: r.isbns.join(';')
  });
}

/* --------------------------------- URL validation --------------------------------- */

/** https URL on an allowlisted host (no credentials/IP/port) or undefined. */
export function okUrl(raw: unknown, allow: RegExp): string | undefined {
  return safeHttpUrl(raw, allow)?.toString();
}

export function okPdfUrl(raw: unknown, allow: RegExp, allowNonExt = false): string | undefined {
  const u = safeHttpUrl(raw, allow);
  if (!u) return undefined;
  if (allowNonExt) return u.toString();
  return u.pathname.toLowerCase().endsWith('.pdf') ? u.toString() : undefined;
}

/* ------------------------------- Rec → Publication ------------------------------- */

export function toExtraPublication(
  r: Rec,
  allow: RegExp,
  extraCountryText: string[] = [],
  allowNonExtPdf = false
): Publication | null {
  const id = r.externalId;
  if (!id || !/^[A-Za-z0-9:._-]+$/.test(id)) return null;
  const landing = okUrl(r.scieloUrl, allow);
  const pdfUrl = okPdfUrl(r.pdfUrl, allow, allowNonExtPdf);
  if (!landing || !pdfUrl) return null;
  const coverUrl = okUrl(r.coverUrl, allow);
  const area = classifyOecdArea({ title: r.title, abstract: r.abstract, keywords: r.keywords, publisher: r.publisher });
  const country = countryOf({ ...r, scieloUrl: landing, pdfUrl }, extraCountryText);

  // sanitizePublication validates every URL against the repo-wide allowlist, so we hand it a harmless trusted
  // placeholder and put the (already per-source validated) URLs back afterwards.
  const clean = sanitizePublication({
    id,
    oaiIdentifier: id,
    title: squash(r.title),
    subtitle: r.subtitle ? squash(r.subtitle) : undefined,
    authors: r.authors,
    publisher: r.publisher ? squash(r.publisher) : r.collection || 'Open Access',
    country,
    collection: r.collection,
    collectionCode: r.collectionCode,
    year: r.year ?? null,
    publicationDate: r.publicationDate,
    language: languageCode(r.language),
    docType: r.docType,
    oecdArea: area.area,
    oecdSubarea: area.subarea,
    abstract: squash(r.abstract),
    keywords: r.keywords,
    doi: r.doi,
    isbn: r.isbns[0],
    scieloUrl: 'https://doi.org/placeholder',
    pageCount: r.pageCount,
    citedByCount: r.cited,
    sourceOrigin: r.origins.includes('openalex') ? 'openalex' : 'oai-pmh'
  });
  if (!clean) return null;
  clean.country = country;
  clean.scieloUrl = landing;
  clean.pdfUrl = pdfUrl;
  clean.coverUrl = coverUrl;
  return clean;
}

/* ------------------------------------ dedupe ------------------------------------ */

function surname(a: string | undefined): string {
  return normTitle((a || '').split(',')[0] || '').split(' ')[0] || '';
}

export function dedupeKeys(r: { title: string; year?: number | null; doi?: string; isbns?: string[]; docType: string; authors?: string[] }): string[] {
  const keys: string[] = [];
  const doi = normalizeDoi(r.doi);
  if (doi) keys.push(`doi:${doi}`);
  if (r.docType === 'book') for (const i of r.isbns || []) keys.push(`isbn:${i}`);
  const nt = normTitle(r.title);
  if (nt.length >= 20) keys.push(`ty:${r.docType === 'article' ? 'article' : 'book'}|${nt}|${r.year ?? ''}|${r.docType === 'article' ? surname(r.authors?.[0]) : ''}`);
  return keys;
}

/** Keys of everything already shipped in migrations/seed (SciELO etc.) so extras never duplicate it. */
export function loadExistingKeys(): Set<string> {
  const keys = new Set<string>();
  const dir = path.join(ROOT_DIR, 'migrations', 'seed');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')) : [];
  for (const f of files) {
    for (const stmt of splitStatements(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      const row = parseInsertLine(stmt);
      if (!row) continue;
      let authors: string[] = [];
      try {
        authors = JSON.parse(String(row.authors_json || '[]')) as string[];
      } catch {
        /* ignore */
      }
      for (const k of dedupeKeys({
        title: String(row.title || ''),
        year: typeof row.publication_year === 'number' ? row.publication_year : null,
        doi: (row.doi as string) || undefined,
        isbns: row.isbn ? [String(row.isbn)] : [],
        docType: String(row.doc_type || 'book'),
        authors
      })) keys.add(k);
    }
  }
  return keys;
}

/* --------------------------------- PDF / image checks --------------------------------- */

export interface PdfProbe {
  url: string;
  ok: boolean;
  detail: string;
}

/** Range GET of the first bytes only: never downloads a whole PDF. */
export async function probePdf(url: string): Promise<PdfProbe> {
  try {
    const res = await fetchWithRetry(url, { timeoutMs: 45_000, maxRetries: 2, headers: { Accept: 'application/pdf,*/*', Range: 'bytes=0-1023' } });
    if (!(res.status === 200 || res.status === 206) || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return { url, ok: false, detail: `HTTP ${res.status}` };
    }
    const reader = res.body.getReader();
    const first = await reader.read();
    await reader.cancel().catch(() => undefined);
    const head = Buffer.from(first.value ?? new Uint8Array()).subarray(0, 5).toString('latin1');
    if (head === '%PDF-') return { url, ok: true, detail: 'ok' };
    const ct = res.headers.get('content-type') || '';
    return { url, ok: false, detail: `no %PDF- magic (${ct.split(';')[0] || 'unknown type'})` };
  } catch (err) {
    return { url, ok: false, detail: (err as Error).message.slice(0, 80) };
  }
}

export function sampleRandom<T>(items: T[], n: number, seed = 20261114): T[] {
  // deterministic xorshift so a re-run checks the same sample unless the data changed
  let x = seed >>> 0 || 1;
  const rnd = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export async function pdfPassRate(urls: string[], n = 25): Promise<NonNullable<SourceReport['pdfSample']>> {
  const sample = sampleRandom(urls, Math.min(n, urls.length));
  const res = await mapPool(sample, 2, (u) => probePdf(u));
  const ok = res.filter((r) => r.ok).length;
  return {
    tested: res.length,
    ok,
    rate: res.length ? ok / res.length : 0,
    failures: res.filter((r) => !r.ok).slice(0, 5).map((r) => `${new URL(r.url).hostname}: ${r.detail}`)
  };
}

/** Image size from the first bytes of a JPEG/PNG (no full download). */
export async function probeImageSize(url: string): Promise<{ ok: boolean; width?: number; height?: number; type?: string; detail?: string }> {
  try {
    const res = await fetchWithRetry(url, { timeoutMs: 30_000, maxRetries: 1, headers: { Range: 'bytes=0-65535' } });
    if (!(res.status === 200 || res.status === 206)) return { ok: false, detail: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 65536);
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { ok: true, type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { ok: true, type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return { ok: true, type: 'jpeg' };
    }
    return { ok: false, detail: 'not an image' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 80) };
  }
}

/* --------------------------------------- SQL --------------------------------------- */

export function writeExtraChunks(code: string, pubs: Publication[], chunkSize = 200): { files: string[]; maxStatementBytes: number } {
  fs.mkdirSync(EXTRA_OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(EXTRA_OUT_DIR)) if (new RegExp(`^${code}_\\d+\\.sql$`).test(f)) fs.rmSync(path.join(EXTRA_OUT_DIR, f));
  const files: string[] = [];
  let maxBytes = 0;
  for (let i = 0; i < pubs.length; i += chunkSize) {
    const lines = pubs.slice(i, i + chunkSize).map((p) => {
      const s = insertStatement(p, true);
      maxBytes = Math.max(maxBytes, Buffer.byteLength(s));
      return s;
    });
    const name = `${code}_${String(files.length + 1).padStart(3, '0')}.sql`;
    fs.writeFileSync(path.join(EXTRA_OUT_DIR, name), lines.join('\n') + '\n', 'utf8');
    files.push(name);
  }
  return { files, maxStatementBytes: maxBytes };
}

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
