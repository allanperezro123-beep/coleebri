/**
 * Curated Classics, Philosophy & Colombian Literature harvester for Coleebri.
 *
 * Collects legally public-domain / open-access works with live-verified `%PDF-` streams:
 *   1. Marxists Internet Archive (www.marxists.org): Karl Marx, Friedrich Engels, Vladimir Lenin,
 *      Rosa Luxemburg, Antonio Gramsci (Spanish + core English classics).
 *   2. Internet Archive (archive.org): strictly public-domain / pre-1930 editions (no lending/DRM,
 *      no modern commercial publisher scans) for Edgar Allan Poe, Immanuel Kant, Arthur Schopenhauer,
 *      Karl Marx, Vladimir Lenin, Nietzsche, Plato, Aristotle, Descartes, Spinoza, Hegel, Rousseau,
 *      Machiavelli, Hobbes, Locke, Hume, Marcus Aurelius, Seneca, and classic Colombian authors
 *      (Jorge Isaacs, José Eustasio Rivera, Tomás Carrasquilla, José Asunción Silva, Rafael Pombo,
 *      Soledad Acosta de Samper, Candelario Obeso, José María Vargas Vila, Eugenio Díaz, etc.).
 *   3. OpenAlex OA Books & Targeted Ibero-American OA Literature/Philosophy: Michel Foucault studies,
 *      philosophy monographs, and Colombian literature books/studies (Gabriel García Márquez,
 *      Álvaro Mutis, Andrés Caicedo, Fernando Vallejo, León de Greiff, etc.).
 *   4. Existing local un-uploaded seed-extra chunks (006+): philosophy & Colombian literature rows.
 *
 * Output (git-ignored):
 *   scripts/out/seed-extra/curated-batch3/curated_NNN.sql
 *   scripts/out/curated-batch3-report.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { sanitizePublication } from '../../functions/publications';
import { foldText, safeHttpUrl } from '../../functions/security';
import { classifyOecdArea, inferCountry } from '../../src/lib/taxonomy';
import type { DocumentType, LanguageCode, OecdAreaId, Publication } from '../../src/types/publication';
import { CACHE_DIR, OUT_DIR, ROOT_DIR, ensureDirs } from './cache';
import { mapPool } from './http';
import { decodeEntities, normalizeDoi, normTitle, squash } from './model';
import { abstractFromInverted } from './openalex';
import { insertStatement, parseInsertLine, splitStatements } from './output';

const BATCH_DIR = path.join(OUT_DIR, 'seed-extra', 'curated-batch3');
const REPORT_PATH = path.join(OUT_DIR, 'curated-batch3-report.json');
const EXISTING_REMOTE_PATH = path.join(CACHE_DIR, 'existing-remote.json');

const UA = 'Coleebri/2.2 (+https://coleebri.pages.dev)';

const TRUSTED_EXISTING_HOSTS =
  /^(?:(?:[a-z0-9-]+\.)*(?:scielo\.(?:org|br|cl|pt|edu\.uy|sa\.cr|sld\.cu|isciii\.es)|scielo\.org\.(?:ar|bo|co|ec|mx|pe|py|ve)|scielo\.iics\.una\.py|doabooks\.org|oapen\.org|doi\.org)|assets\.verlag\.gta\.arch\.ethz\.ch|ciencialatina\.org|die\.udistrital\.edu\.co|downloads\.editoracientifica\.com\.br|e-archivo\.uc3m\.es|editorial\.ucatolicaluisamigo\.edu\.co|editorialmarcaribe\.es|edizionicafoscari\.unive\.it|eladd\.org|intech-files\.s3\.amazonaws\.com|libros\.unad\.edu\.co|libros\.univalle\.edu\.co|melusina-pubs\.fra1\.digitaloceanspaces\.com|mts\.intechopen\.com|portalcris\.vdu\.lt|pure\.iiasa\.ac\.at|real\.mtak\.hu|repository\.unad\.edu\.co|repository\.uniminuto\.edu|researchonline\.lse\.ac\.uk|revistas\.upsa\.es|revistasonline\.inap\.es|sauyayinlari\.sakarya\.edu\.tr|skyfox\.co|sophiaeditions\.com|www\.berghahnbooks\.com|www\.cambridge\.org|www\.editoracientifica\.com\.br|www\.editoracrv\.com\.br|www\.ledizioni\.it|www\.logos-verlag\.de|www\.redalyc\.org|www\.sav\.sk|www\.seankingston\.co\.uk|www\.vdu\.lt|www\.viella\.it|www\.zaphon\.de)$/i;

const CANDIDATE_NEW_HOSTS =
  /^(?:(?:[a-z0-9-]+\.)*archive\.org|www\.marxists\.org|ariadnaediciones\.cl|ora\.ox\.ac\.uk|d-nb\.info|univerlag\.uni-goettingen\.de|www\.univerlag\.uni-goettingen\.de)$/i;

const CLINICAL_NOISE =
  /\b(cl[ií]nic[oa]|hospital|paciente|patient|salud p[uú]blica|covid|pandemia|vacun|enfermer|medicin[ae]|cirug|diagn[oó]stic|terapia|f[aá]rmac|odontolog|veterin|agronom|cultivo de|bovin|porcin|av[ií]col|ingenier[ií]a civil|electr[oó]nic|mec[aá]nic|contabilidad|auditor[ií]a|marketing|systematic literature review|revisi[oó]n sistem[aá]tica de la literatura|case report|reporte de caso|plan de negocios|labor conditions|journalists|cooperativo|cuidado de enferm|christianity.*how to be saved)\b/i;

const MODERN_COMMERCIAL_PUBLISHERS =
  /\b(gredos|alfaguara|alianza editorial|c[aá]tedra|akal|losada|planeta|anagrama|tusquets|paid[oó]s|fondo de cultura econ[oó]mica|trotta|herder|tecnos|siglo xxi|edaf|porr[uú]a|penguin|oxford university press|cambridge university press|routledge|de gruyter|springer|elsevier|wiley|harpercollins|random house|w\.?\s*w\.?\s*norton|seix barral|espasa|siruela|acantilado|debates|vintage|delphi collected works|delphi classics|epublibre|epl fs|roberto aramayo|pedro ribas)\b/i;

const JUNK_DOC =
  /\b(ppt|diapositivas|powerpoint|summary of|study guide|sparknotes|cliffsnotes|homework|test prep|workbook|lesson plan|genealogy|descendants of|directory of|telephone|almanac|minutes of|annual report|catalog of|dictionary of music|history of england|how to be saved|supplementary reading|xmca|biographies of marx)\b/i;

interface Candidate {
  id: string;
  title: string;
  subtitle?: string;
  authors: string[];
  publisher: string;
  country: string;
  collection: string;
  collectionCode: string;
  year: number | null;
  publicationDate?: string;
  language: LanguageCode;
  docType: DocumentType;
  oecdArea: OecdAreaId;
  oecdSubarea?: string;
  abstract: string;
  keywords: string[];
  doi?: string;
  isbn?: string;
  scieloUrl: string;
  pdfUrl: string;
  citedByCount: number;
  sourceOrigin: 'oai-pmh' | 'opds' | 'openalex';
  categoryTag: string;
}

interface PdfVerifyResult {
  ok: boolean;
  finalHost?: string;
  detail: string;
}

async function verifyPdfStream(url: string): Promise<PdfVerifyResult> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', Range: 'bytes=0-1023' },
      redirect: 'follow',
      signal: AbortSignal.timeout(14_000)
    });
    if (!(res.status === 200 || res.status === 206) || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    const finalHost = new URL(res.url).hostname.toLowerCase();
    const reader = res.body.getReader();
    const first = await reader.read();
    await reader.cancel().catch(() => undefined);
    const buf = Buffer.from(first.value ?? new Uint8Array());
    if (buf.subarray(0, 5).toString('latin1') === '%PDF-') {
      return { ok: true, finalHost, detail: 'ok' };
    }
    const ct = (res.headers.get('content-type') || '').split(';')[0];
    return { ok: false, finalHost, detail: `no %PDF- (${ct || 'unknown'})` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 80) };
  }
}

function fixMojibake(s: string): string {
  if (!/Ã[\u0080-\u00BF]/.test(s)) return s;
  try {
    const decoded = Buffer.from(s, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? s : decoded;
  } catch {
    return s;
  }
}

function toTitleCase(s: string): string {
  const minor = new Set(['of', 'the', 'and', 'in', 'on', 'to', 'a', 'an', 'for', 'or', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'en', 'con', 'por', 'para']);
  return s
    .split(/\s+/)
    .map((w, i) => {
      if (!w) return w;
      if (/^[IVXLCDM]+$/i.test(w) && w.length <= 5) return w.toUpperCase();
      const low = w.toLowerCase();
      if (i > 0 && minor.has(low)) return low;
      return low.charAt(0).toUpperCase() + low.slice(1);
    })
    .join(' ');
}

function cleanPersonName(raw: string): string {
  return squash(fixMojibake(raw))
    .replace(/\(\s+/g, '')
    .replace(/,\s*\d{4}-(?:\d{4})?\.?$/g, '')
    .replace(/,\s*author\.?$/i, '')
    .replace(/\s+author$/i, '')
    .replace(/[,;.]+$/g, '')
    .trim();
}

function dedupeTitleKey(title: string, authors: string[]): string {
  let t = foldText(fixMojibake(title))
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const a of authors) {
    const last = foldText(a).replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim().split(/\s+/).pop() || '';
    if (last.length >= 3) {
      t = t.replace(new RegExp(`\\b${last}\\b`, 'g'), ' ');
    }
  }
  t = t
    .replace(/\b(marx|engels|lenin|kant|schopenhauer|poe|isaacs|rivera|carrasquilla|silva|pombo|nietzsche|plato|platon|aristotle|aristoteles|the|a|an|of|in|on|el|la|los|las|de|del|y|pdf|ocr|vol|volume|tomo)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

function loadRemoteExisting(): { ids: Set<string>; titles: Set<string>; dois: Set<string> } {
  const ids = new Set<string>();
  const titles = new Set<string>();
  const dois = new Set<string>();
  if (!fs.existsSync(EXISTING_REMOTE_PATH)) return { ids, titles, dois };
  const buf = fs.readFileSync(EXISTING_REMOTE_PATH);
  let raw =
    buf[0] === 0xff && buf[1] === 0xfe
      ? buf.subarray(2).toString('utf16le')
      : buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
        ? buf.subarray(3).toString('utf8')
        : buf.toString('utf8');
  raw = raw.slice(raw.indexOf('['));
  const parsed = JSON.parse(raw) as Array<{ results?: Array<{ id: string; title: string; doi?: string | null }> }>;
  for (const row of parsed[0]?.results ?? []) {
    ids.add(row.id);
    const nt = normTitle(row.title);
    if (nt) titles.add(nt);
    const d = normalizeDoi(row.doi ?? undefined);
    if (d) dois.add(d);
  }
  return { ids, titles, dois };
}

function cleanHtmlText(s: string): string {
  return squash(fixMojibake(decodeEntities(s.replace(/<[^>]*>/g, ' '))));
}

function parseYearFromText(s: string | number | undefined | null): number | null {
  if (typeof s === 'number' && Number.isFinite(s)) {
    const y = Math.trunc(s);
    return y >= 1500 && y <= 2027 ? y : null;
  }
  const m = /\b(1[5-9]\d{2}|20[0-2]\d)\b/.exec(String(s || ''));
  return m ? Number(m[1]) : null;
}

function inferLang(raw: unknown, title = ''): LanguageCode {
  const s = Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
  const l = s.trim().toLowerCase();
  if (/^(es|spa|spanish|español|castellano)/.test(l)) return 'es';
  if (/^(pt|por|portuguese|portugu)/.test(l)) return 'pt';
  if (/^(fr|fre|fra|french|franc|de|ger|deu|german|aleman|alemán|it|ita|ben|urd)/.test(l)) return 'other';
  if (/^(en|eng|english|inglés|ingles)/.test(l)) {
    if (/\b(critique du|eléments métaphysiques|de la naturaleza|historia|filosofía|poesías|marquesa|vorágine|soledad)\b/i.test(title)) {
      return /\b(du|des|métaphysiques|suivie)\b/i.test(title) ? 'other' : 'es';
    }
    return 'en';
  }
  if (/[áéíóúñ¿¡]/i.test(title) || /\b(la|el|los|las|de|del|sobre|crítica|historia|filosofía|poesías|cuentos)\b/i.test(title)) {
    return 'es';
  }
  return 'other';
}

function slugId(prefix: string, raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${prefix}-${clean}`.slice(0, 118);
}

/* -------------------------------------------------------------------------- */
/* Stage 1: Marxists Internet Archive (Marx, Engels, Lenin, Luxemburg...)     */
/* -------------------------------------------------------------------------- */

function miaAuthorFromUrl(url: string, linkText: string): { authors: string[]; tag: string; area: OecdAreaId } {
  const low = `${url} ${linkText}`.toLowerCase();
  if (/\/lenin\/|lenin/.test(low)) return { authors: ['Vladimir Lenin'], tag: 'Lenin', area: 'social-sciences' };
  if (/\/luxem\/|luxemburg/.test(low)) return { authors: ['Rosa Luxemburg'], tag: 'Filosofía Política', area: 'social-sciences' };
  if (/\/gramsci\/|gramsci/.test(low)) return { authors: ['Antonio Gramsci'], tag: 'Filosofía Política', area: 'humanities' };
  if (/engels/.test(low) && !/marx/.test(low)) return { authors: ['Friedrich Engels'], tag: 'Karl Marx', area: 'social-sciences' };
  if (/manifiesto|manifesto|ideologia|ideology|sagrada|holy|engels/.test(low)) {
    return { authors: ['Karl Marx', 'Friedrich Engels'], tag: 'Karl Marx', area: 'social-sciences' };
  }
  return { authors: ['Karl Marx'], tag: 'Karl Marx', area: 'social-sciences' };
}

async function harvestMia(): Promise<Candidate[]> {
  const seeds = [
    'https://www.marxists.org/espanol/m-e/indice.htm',
    'https://www.marxists.org/espanol/m-e/index.htm',
    'https://www.marxists.org/espanol/lenin/index.htm',
    'https://www.marxists.org/espanol/lenin/obras/index.htm',
    'https://www.marxists.org/espanol/luxem/index.htm',
    'https://www.marxists.org/espanol/gramsci/index.htm',
    'https://www.marxists.org/archive/marx/works/download/index.htm',
    'https://www.marxists.org/archive/lenin/works/download/index.htm'
  ];

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = seeds.map((url) => ({ url, depth: 0 }));
  const found = new Map<string, { url: string; title: string; pageUrl: string; lang: LanguageCode }>();

  while (queue.length > 0 && visited.size < 90) {
    const batch = queue.splice(0, 6);
    await Promise.all(
      batch.map(async ({ url, depth }) => {
        if (visited.has(url)) return;
        visited.add(url);
        try {
          const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
          if (!res.ok) return;
          const html = await res.text();
          for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
            const href = m[1].trim();
            if (!href || href.startsWith('mailto:') || href.startsWith('javascript:')) continue;
            let abs: string;
            try {
              abs = new URL(href, url).toString();
            } catch {
              continue;
            }
            if (!abs.startsWith('https://www.marxists.org/')) continue;

            if (/\.pdf$/i.test(abs)) {
              const isEs = abs.startsWith('https://www.marxists.org/espanol/');
              const isEnCore = /^https:\/\/www\.marxists\.org\/archive\/(?:marx|lenin)\//i.test(abs);
              if (!isEs && !isEnCore) continue;
              if (/kiosko\/(argentina|chile|palestina)/i.test(abs)) continue;
              if (/mecw|xmca|supplementary|biographies/i.test(abs)) continue;
              const rawText = cleanHtmlText(m[2]);
              const fileBase = decodeURIComponent(abs.split('/').pop() || '')
                .replace(/\.pdf$/i, '')
                .replace(/[-_]+/g, ' ');
              let cleanLabel =
                rawText && !/^(pdf|descargar|download|aquí|aqui|ver|volume\s+\w+)$/i.test(rawText) && rawText.length >= 4
                  ? rawText
                  : toTitleCase(fileBase);
              if (cleanLabel === cleanLabel.toLowerCase()) cleanLabel = toTitleCase(cleanLabel);
              if (!found.has(abs)) {
                found.set(abs, { url: abs, title: cleanLabel, pageUrl: url, lang: isEs ? 'es' : 'en' });
              }
            } else if (
              depth < 2 &&
              /\.htm$/i.test(abs) &&
              /(?:^https:\/\/www\.marxists\.org\/espanol\/(?:m-e|lenin|luxem|gramsci)\/|download|indice|index|obras)/i.test(abs) &&
              !visited.has(abs)
            ) {
              queue.push({ url: abs, depth: depth + 1 });
            }
          }
        } catch {
          // ignore unreachable index
        }
      })
    );
  }

  // Sort Spanish works first, then core English works, capping English Marx at 45 to keep collection balanced
  const allFound = [...found.values()].sort((a, b) => (a.lang === 'es' ? 0 : 1) - (b.lang === 'es' ? 0 : 1));
  const candidates: Candidate[] = [];
  let enMarxCount = 0;

  for (const item of allFound) {
    const info = miaAuthorFromUrl(item.url, item.title);
    const title = item.title
      .replace(/\s*\(pdf\)\s*/gi, '')
      .replace(/^pdf:\s*/i, '')
      .replace(/^(?:Marx|Lenin|Engels)\s+(?=(?:On|The|Critique|Contribution|Selected|Articles|Mathematical|Conflict|German|First|Hague|Holy)\b)/i, '')
      .trim();
    if (title.length < 4 || JUNK_DOC.test(title)) continue;
    if (item.lang === 'en' && info.tag === 'Karl Marx') {
      if (enMarxCount >= 45) continue;
      enMarxCount += 1;
    }
    const year = parseYearFromText(item.url) ?? parseYearFromText(title);
    candidates.push({
      id: slugId('mia', item.url.replace('https://www.marxists.org/', '')),
      title,
      authors: info.authors,
      publisher: 'Marxists Internet Archive',
      country: 'Internacional',
      collection: 'Archivo Marxists (OA)',
      collectionCode: 'marxists',
      year,
      language: item.lang,
      docType: 'book',
      oecdArea: info.area,
      oecdSubarea: 'Filosofía Política y Economía',
      abstract: `Obra clásica de ${info.authors.join(' y ')} en acceso abierto digitalizada y preservada por Marxists Internet Archive.`,
      keywords: [...info.authors, 'Filosofía política', 'Economía política', 'Acceso abierto'],
      scieloUrl: item.pageUrl,
      pdfUrl: item.url,
      citedByCount: 50,
      sourceOrigin: 'opds',
      categoryTag: info.tag
    });
  }
  return candidates;
}

/* -------------------------------------------------------------------------- */
/* Stage 2: Internet Archive (Strictly Verified Public Domain)                */
/* -------------------------------------------------------------------------- */

interface IaSpec {
  tag: string;
  query: string;
  rows: number;
  defaultAuthor?: string;
  requiredCreatorToken?: RegExp;
  countryOverride?: string;
  oecdArea: OecdAreaId;
  subarea: string;
  keywords: string[];
  allowPost1930?: boolean;
}

const IA_SPECS: IaSpec[] = [
  {
    tag: 'Edgar Allan Poe',
    query: 'creator:("Edgar Allan Poe") AND mediatype:(texts) AND -collection:(inlibrary) AND -collection:(printdisabled) AND year:[1827 TO 1929] AND language:(spa OR Spanish OR eng OR English) AND format:("Text PDF" OR "PDF")',
    rows: 80,
    defaultAuthor: 'Edgar Allan Poe',
    requiredCreatorToken: /poe/i,
    oecdArea: 'humanities',
    subarea: 'Literatura Universal',
    keywords: ['Edgar Allan Poe', 'Literatura', 'Cuentos', 'Poesía', 'Dominio público']
  },
  {
    tag: 'Immanuel Kant',
    query: 'creator:("Immanuel Kant") AND mediatype:(texts) AND -collection:(inlibrary) AND -collection:(printdisabled) AND year:[1750 TO 1929] AND language:(spa OR Spanish OR eng OR English) AND format:("Text PDF" OR "PDF")',
    rows: 80,
    defaultAuthor: 'Immanuel Kant',
    requiredCreatorToken: /kant/i,
    oecdArea: 'humanities',
    subarea: 'Filosofía Moderna',
    keywords: ['Immanuel Kant', 'Filosofía', 'Epistemología', 'Ética', 'Ilustración']
  },
  {
    tag: 'Arthur Schopenhauer',
    query: 'creator:("Arthur Schopenhauer") AND mediatype:(texts) AND -collection:(inlibrary) AND -collection:(printdisabled) AND year:[1810 TO 1929] AND language:(spa OR Spanish OR eng OR English) AND format:("Text PDF" OR "PDF")',
    rows: 60,
    defaultAuthor: 'Arthur Schopenhauer',
    requiredCreatorToken: /schopenhauer/i,
    oecdArea: 'humanities',
    subarea: 'Filosofía Moderna',
    keywords: ['Arthur Schopenhauer', 'Filosofía', 'Metafísica', 'Voluntad', 'Ética']
  },
  {
    tag: 'Karl Marx',
    query: 'creator:("Karl Marx") AND mediatype:(texts) AND -collection:(inlibrary) AND -collection:(printdisabled) AND year:[1840 TO 1929] AND language:(spa OR Spanish OR eng OR English) AND format:("Text PDF" OR "PDF")',
    rows: 40,
    defaultAuthor: 'Karl Marx',
    requiredCreatorToken: /marx/i,
    oecdArea: 'social-sciences',
    subarea: 'Economía Política y Filosofía',
    keywords: ['Karl Marx', 'Economía política', 'Materialismo histórico', 'Filosofía']
  },
  {
    tag: 'Lenin',
    query: 'creator:("Vladimir" AND "Lenin") AND mediatype:(texts) AND -collection:(inlibrary) AND -collection:(printdisabled) AND year:[1895 TO 1929] AND language:(spa OR Spanish OR eng OR English) AND format:("Text PDF" OR "PDF")',
    rows: 35,
    defaultAuthor: 'Vladimir Lenin',
    requiredCreatorToken: /lenin/i,
    oecdArea: 'social-sciences',
    subarea: 'Teoría Política',
    keywords: ['Vladimir Lenin', 'Teoría política', 'Estado', 'Historia']
  },
  {
    tag: 'Filósofos Famosos (Nietzsche, Spinoza, Descartes, Hegel)',
    query: 'creator:("Friedrich Nietzsche" OR "Baruch Spinoza" OR "René Descartes" OR "Georg Wilhelm Friedrich Hegel" OR "Jean-Jacques Rousseau" OR "Thomas Hobbes" OR "John Locke" OR "David Hume") AND mediatype:(texts) AND -collection:(inlibrary) AND -collection:(printdisabled) AND year:[1600 TO 1929] AND language:(spa OR Spanish OR eng OR English) AND format:("Text PDF" OR "PDF")',
    rows: 90,
    requiredCreatorToken: /nietzsche|spinoza|descartes|hegel|rousseau|hobbes|locke|hume/i,
    oecdArea: 'humanities',
    subarea: 'Filosofía Clásica y Moderna',
    keywords: ['Filosofía', 'Metafísica', 'Ética', 'Filosofía política']
  },
  {
    tag: 'Filósofos Antiguos y Renacentistas (Platón, Aristóteles, Marco Aurelio, Séneca, Maquiavelo)',
    query: 'creator:("Plato" OR "Platón" OR "Aristotle" OR "Aristóteles" OR "Marcus Aurelius" OR "Marco Aurelio" OR "Seneca" OR "Séneca" OR "Niccolò Machiavelli" OR "Nicolás Maquiavelo") AND mediatype:(texts) AND -collection:(inlibrary) AND -collection:(printdisabled) AND year:[1500 TO 1929] AND language:(spa OR Spanish OR eng OR English) AND format:("Text PDF" OR "PDF")',
    rows: 80,
    requiredCreatorToken: /plat[oó]n|arist[oó]t|aureli|seneca|s[eé]neca|machiavell|maquiavel/i,
    oecdArea: 'humanities',
    subarea: 'Filosofía Antigua y Renacentista',
    keywords: ['Filosofía clásica', 'Ética', 'Política', 'Antigüedad']
  },
  {
    tag: 'Literatura Colombiana Clásica',
    query: 'creator:("Jorge Isaacs" OR "José Eustasio Rivera" OR "Tomás Carrasquilla" OR "José Asunción Silva" OR "Rafael Pombo" OR "Candelario Obeso" OR "Soledad Acosta de Samper" OR "José María Vargas Vila" OR "Eugenio Díaz" OR "Julio Flórez" OR "Rufino José Cuervo" OR "Gregorio Gutiérrez González" OR "José Manuel Marroquín" OR "Cordovez Moure") AND mediatype:(texts) AND -collection:(inlibrary) AND -collection:(printdisabled) AND format:("Text PDF" OR "PDF")',
    rows: 100,
    requiredCreatorToken: /isaacs|rivera|carrasquilla|silva|pombo|obeso|acosta|samper|vargas|vila|d[ií]az|fl[oó]rez|cuervo|guti[eé]rrez|marroqu[ií]n|cordovez/i,
    countryOverride: 'Colombia',
    oecdArea: 'humanities',
    subarea: 'Literatura Colombiana',
    keywords: ['Literatura colombiana', 'Colombia', 'Novela', 'Poesía', 'Patrimonio literario'],
    allowPost1930: true
  }
];

interface IaDoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  year?: string | number;
  language?: string | string[];
  licenseurl?: string;
  publisher?: string | string[];
  downloads?: number;
}

interface IaMetadataResponse {
  metadata?: {
    mediatype?: string;
    'access-restricted-item'?: string;
    publisher?: string | string[];
    description?: string | string[];
    date?: string;
    year?: string;
    licenseurl?: string;
  };
  files?: Array<{
    name: string;
    format?: string;
    private?: string;
    size?: string;
  }>;
}

async function harvestInternetArchive(): Promise<Candidate[]> {
  const seenIa = new Set<string>();
  const rawDocs: Array<{ doc: IaDoc; spec: IaSpec }> = [];

  for (const spec of IA_SPECS) {
    const url =
      `https://archive.org/advancedsearch.php?q=${encodeURIComponent(spec.query)}` +
      `&fl[]=identifier,title,creator,year,language,licenseurl,publisher,downloads` +
      `&sort[]=downloads+desc&rows=${spec.rows}&output=json`;
    try {
      const res = (await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) }).then((r) => r.json())) as {
        response?: { docs?: IaDoc[] };
      };
      for (const doc of res.response?.docs ?? []) {
        if (!doc.identifier || seenIa.has(doc.identifier)) continue;
        seenIa.add(doc.identifier);
        rawDocs.push({ doc, spec });
      }
    } catch {
      // continue on transient IA search error
    }
  }

  const candidates: Candidate[] = [];
  await mapPool(rawDocs, 8, async ({ doc, spec }) => {
    const rawTitle = Array.isArray(doc.title) ? doc.title[0] : doc.title || '';
    const title = squash(fixMojibake(rawTitle));
    if (!title || title.length < 3 || JUNK_DOC.test(title) || CLINICAL_NOISE.test(title)) return;

    const rawCreator = Array.isArray(doc.creator) ? doc.creator.join('; ') : doc.creator || spec.defaultAuthor || '';
    if (spec.requiredCreatorToken && !spec.requiredCreatorToken.test(rawCreator)) return;

    const rawPub = Array.isArray(doc.publisher) ? doc.publisher.join('; ') : doc.publisher || '';
    const rawYear = parseYearFromText(doc.year);
    const lic = String(doc.licenseurl || '').toLowerCase();

    // Strict copyright safety gate: non-Colombian IA items MUST be pre-1930 public domain scans;
    // Colombian classic authors (died > 80y ago) allow pre-1945 or explicit CC0/publicdomain community editions
    if (!spec.allowPost1930) {
      if (!rawYear || rawYear > 1929) return;
    } else {
      if (rawYear && rawYear > 1945 && !lic.includes('zero/1.0') && !lic.includes('publicdomain/mark/1.0')) return;
      if (!rawYear && !lic.includes('publicdomain') && !lic.includes('creativecommons') && !/goog$|mala$|uoft$|iala$|robarts$|americana$|bub_gb_/i.test(doc.identifier)) {
        return;
      }
    }
    if (MODERN_COMMERCIAL_PUBLISHERS.test(`${title} ${rawPub} ${doc.identifier}`) && (!rawYear || rawYear > 1929)) return;

    try {
      const meta = (await fetch(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10_000)
      }).then((r) => r.json())) as IaMetadataResponse;

      if (!meta.metadata || meta.metadata.mediatype !== 'texts') return;
      if (meta.metadata['access-restricted-item'] === 'true') return;

      const metaPub = Array.isArray(meta.metadata.publisher) ? meta.metadata.publisher.join('; ') : meta.metadata.publisher || rawPub;
      const metaDesc = cleanHtmlText(Array.isArray(meta.metadata.description) ? meta.metadata.description[0] || '' : meta.metadata.description || '');
      const metaYear = rawYear ?? parseYearFromText(meta.metadata.year ?? meta.metadata.date);
      const metaLic = String(meta.metadata.licenseurl || lic).toLowerCase();

      if (MODERN_COMMERCIAL_PUBLISHERS.test(`${title} ${metaPub} ${metaDesc}`) && (!metaYear || metaYear > 1929)) return;
      if (!spec.allowPost1930 && (!metaYear || metaYear > 1929)) return;
      if (spec.allowPost1930 && metaYear && metaYear > 1945 && !metaLic.includes('zero/1.0') && !metaLic.includes('publicdomain/mark/1.0')) return;
      if (JUNK_DOC.test(metaDesc) || CLINICAL_NOISE.test(metaDesc)) return;

      const files = (meta.files || []).filter(
        (f) =>
          f.name &&
          f.name.toLowerCase().endsWith('.pdf') &&
          f.private !== 'true' &&
          f.format !== 'ACS Encrypted PDF' &&
          Number(f.size || 0) >= 20_000 &&
          Number(f.size || 0) <= 60_000_000
      );
      if (!files.length) return;
      files.sort((a, b) => {
        const aScore = (a.format === 'Text PDF' ? 2 : 0) + (Number(a.size || 0) <= 25_000_000 ? 1 : 0);
        const bScore = (b.format === 'Text PDF' ? 2 : 0) + (Number(b.size || 0) <= 25_000_000 ? 1 : 0);
        return bScore - aScore || Number(a.size || 0) - Number(b.size || 0);
      });
      const chosen = files[0];
      const pdfUrl = `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${chosen.name.split('/').map(encodeURIComponent).join('/')}`;
      const landingUrl = `https://archive.org/details/${encodeURIComponent(doc.identifier)}`;

      const authors = rawCreator
        .split(/[;|]/)
        .map(cleanPersonName)
        .filter((a) => a.length >= 2 && !/^\d+$/.test(a))
        .slice(0, 10);
      if (!authors.length && spec.defaultAuthor) authors.push(spec.defaultAuthor);

      const lang = inferLang(doc.language, title);
      if (lang === 'other' && !spec.countryOverride) return; // keep es/en (keep Colombian classics even if untagged)
      const finalLang: LanguageCode = spec.countryOverride && lang === 'other' ? 'es' : lang;

      const pubName = squash(fixMojibake(metaPub)) || 'Internet Archive · Dominio Público';
      const abstract =
        metaDesc.length >= 25
          ? metaDesc.slice(0, 2000)
          : `Edición digital de dominio público de "${title}" (${authors.join(', ') || spec.tag}), preservada en Internet Archive.`;

      candidates.push({
        id: slugId('ia', doc.identifier),
        title,
        authors,
        publisher: pubName,
        country: spec.countryOverride || 'Internacional',
        collection: 'Clásicos · Internet Archive',
        collectionCode: 'archive',
        year: metaYear,
        language: finalLang,
        docType: 'book',
        oecdArea: spec.oecdArea,
        oecdSubarea: spec.subarea,
        abstract,
        keywords: [...spec.keywords, ...authors.slice(0, 2)],
        scieloUrl: landingUrl,
        pdfUrl,
        citedByCount: Math.min(5000, Math.max(1, Math.round((doc.downloads || 10) / 50))),
        sourceOrigin: 'opds',
        categoryTag: spec.tag
      });
    } catch {
      // skip item on metadata error
    }
  });

  // Sort Spanish editions before English editions within IA so dedupe keeps Spanish when available
  candidates.sort((a, b) => (a.language === 'es' ? 0 : 1) - (b.language === 'es' ? 0 : 1));
  return candidates;
}

/* -------------------------------------------------------------------------- */
/* Stage 3: OpenAlex OA Books & Targeted Ibero-American OA Literature/Phil    */
/* -------------------------------------------------------------------------- */

interface OaQuerySpec {
  tag: string;
  search: string;
  docTypes: 'book' | 'book|article';
  languages?: string;
  perPage: number;
  oecdArea: OecdAreaId;
  subarea: string;
  countryOverride?: string;
  requireKeywordInTitleOrAbstract?: RegExp;
}

const OA_SPECS: OaQuerySpec[] = [
  {
    tag: 'Michel Foucault (OA)',
    search: 'Michel Foucault',
    docTypes: 'book',
    perPage: 60,
    oecdArea: 'humanities',
    subarea: 'Filosofía Contemporánea',
    requireKeywordInTitleOrAbstract: /foucault/i
  },
  {
    tag: 'Michel Foucault (ES/PT)',
    search: 'Michel Foucault',
    docTypes: 'book|article',
    languages: 'es|pt',
    perPage: 60,
    oecdArea: 'humanities',
    subarea: 'Filosofía Contemporánea',
    requireKeywordInTitleOrAbstract: /foucault/i
  },
  {
    tag: 'Immanuel Kant (OA)',
    search: 'Immanuel Kant',
    docTypes: 'book',
    perPage: 40,
    oecdArea: 'humanities',
    subarea: 'Filosofía Moderna',
    requireKeywordInTitleOrAbstract: /\bkant\b/i
  },
  {
    tag: 'Karl Marx (OA)',
    search: 'Karl Marx',
    docTypes: 'book',
    perPage: 40,
    oecdArea: 'social-sciences',
    subarea: 'Economía Política y Filosofía',
    requireKeywordInTitleOrAbstract: /\bmarx\b/i
  },
  {
    tag: 'Vladimir Lenin (OA)',
    search: 'Vladimir Lenin',
    docTypes: 'book',
    perPage: 30,
    oecdArea: 'social-sciences',
    subarea: 'Teoría Política',
    requireKeywordInTitleOrAbstract: /\blenin\b/i
  },
  {
    tag: 'Arthur Schopenhauer (OA)',
    search: 'Arthur Schopenhauer',
    docTypes: 'book',
    perPage: 35,
    oecdArea: 'humanities',
    subarea: 'Filosofía Moderna',
    requireKeywordInTitleOrAbstract: /schopenhauer/i
  },
  {
    tag: 'Edgar Allan Poe (OA)',
    search: 'Edgar Allan Poe',
    docTypes: 'book|article',
    languages: 'es|en',
    perPage: 45,
    oecdArea: 'humanities',
    subarea: 'Literatura Universal',
    requireKeywordInTitleOrAbstract: /edgar allan poe|\bpoe\b/i
  },
  {
    tag: 'Filosofía Moderna y Antigua (OA)',
    search: 'Friedrich Nietzsche Baruch Spinoza Hegel Aristóteles Platón',
    docTypes: 'book',
    perPage: 40,
    oecdArea: 'humanities',
    subarea: 'Filosofía',
    requireKeywordInTitleOrAbstract: /nietzsche|spinoza|hegel|arist[oó]teles|aristotle|plat[oó]n|plato|filosof/i
  },
  {
    tag: 'Literatura Colombiana (OA)',
    search: 'literatura colombiana',
    docTypes: 'book|article',
    languages: 'es|en',
    perPage: 80,
    oecdArea: 'humanities',
    subarea: 'Literatura Colombiana',
    countryOverride: 'Colombia',
    requireKeywordInTitleOrAbstract:
      /literatura colombiana|novela colombiana|poes[ií]a colombiana|garc[ií]a m[aá]rquez|jorge isaacs|eustasio rivera|carrasquilla|asunci[oó]n silva|andr[eé]s caicedo|[aá]lvaro mutis|fernando vallejo|marvel moreno|le[oó]n de greiff/i
  },
  {
    tag: 'Gabriel García Márquez y Autores Colombianos (OA)',
    search: '"Gabriel García Márquez" OR "Álvaro Mutis" OR "Andrés Caicedo" OR "José Asunción Silva" OR "Tomás Carrasquilla" OR "Jorge Isaacs" OR "José Eustasio Rivera"',
    docTypes: 'book|article',
    languages: 'es|en',
    perPage: 80,
    oecdArea: 'humanities',
    subarea: 'Literatura Colombiana',
    countryOverride: 'Colombia',
    requireKeywordInTitleOrAbstract:
      /garc[ií]a m[aá]rquez|mutis|caicedo|vallejo|carrasquilla|isaacs|rivera|silva|pombo|moreno|greiff|literatura colombiana|macondo|vor[aá]gine/i
  }
];

interface OaWorkResp {
  id: string;
  doi?: string | null;
  title?: string | null;
  type?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  language?: string | null;
  primary_location?: { landing_page_url?: string | null; pdf_url?: string | null; source?: { display_name?: string | null } | null } | null;
  best_oa_location?: { landing_page_url?: string | null; pdf_url?: string | null; source?: { display_name?: string | null } | null } | null;
  authorships?: Array<{ author?: { display_name?: string } | null }> | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  cited_by_count?: number;
  keywords?: Array<{ display_name?: string }> | null;
  primary_topic?: { display_name?: string; field?: { display_name?: string }; domain?: { id?: string } } | null;
}

async function harvestOpenAlexTargeted(): Promise<Candidate[]> {
  const seenOa = new Set<string>();
  const candidates: Candidate[] = [];

  for (const spec of OA_SPECS) {
    const langFilter = spec.languages ? `,language:${spec.languages}` : ',language:es|en|pt';
    const url =
      `https://api.openalex.org/works?search=${encodeURIComponent(spec.search)}` +
      `&filter=type:${spec.docTypes},is_oa:true,has_fulltext:true${langFilter}` +
      `&per-page=${spec.perPage}`;
    try {
      const res = (await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) }).then((r) => r.json())) as {
        results?: OaWorkResp[];
      };
      for (const w of res.results ?? []) {
        const oaId = w.id.split('/').pop();
        if (!oaId || seenOa.has(oaId)) continue;
        seenOa.add(oaId);

        const title = squash(w.title || '');
        if (!title || title.length < 4) continue;
        const abstract = squash(abstractFromInverted(w.abstract_inverted_index));
        const combined = `${title} ${abstract}`;
        if (CLINICAL_NOISE.test(combined) || JUNK_DOC.test(combined)) continue;
        if (spec.requireKeywordInTitleOrAbstract && !spec.requireKeywordInTitleOrAbstract.test(combined)) continue;

        const pdfUrl = [w.best_oa_location?.pdf_url, w.primary_location?.pdf_url]
          .map((u) => safeHttpUrl(u, null)?.toString())
          .find((u) => u && (TRUSTED_EXISTING_HOSTS.test(new URL(u).hostname) || CANDIDATE_NEW_HOSTS.test(new URL(u).hostname)));
        if (!pdfUrl) continue;

        const doi = normalizeDoi(w.doi ?? undefined);
        const landing =
          [w.best_oa_location?.landing_page_url, w.primary_location?.landing_page_url, doi ? `https://doi.org/${doi}` : undefined, pdfUrl]
            .map((u) => safeHttpUrl(u, null)?.toString())
            .find((u) => u && (TRUSTED_EXISTING_HOSTS.test(new URL(u).hostname) || CANDIDATE_NEW_HOSTS.test(new URL(u).hostname))) ||
          pdfUrl;

        const authors = (w.authorships || []).map((a) => squash(a.author?.display_name || '')).filter(Boolean).slice(0, 25);
        const publisher =
          squash(w.best_oa_location?.source?.display_name || w.primary_location?.source?.display_name || '') || 'OpenAlex OA';
        const keywords = (w.keywords || []).map((k) => squash(k.display_name || '')).filter(Boolean).slice(0, 15);
        const docType: DocumentType = w.type === 'article' ? 'article' : 'book';
        const area = classifyOecdArea({
          title,
          abstract,
          keywords,
          publisher,
          openAlexDomainId: w.primary_topic?.domain?.id,
          openAlexFieldName: w.primary_topic?.field?.display_name
        });
        if (area.area === 'medical-health' || area.area === 'agricultural-sciences' || area.area === 'engineering-tech') continue;
        const finalArea: OecdAreaId = area.area === 'humanities' || area.area === 'social-sciences' ? area.area : spec.oecdArea;

        candidates.push({
          id: `oa-${oaId}`,
          title,
          authors,
          publisher,
          country: spec.countryOverride || inferCountry({ publisher, scieloUrl: landing, pdfUrl }),
          collection: docType === 'book' ? 'Libros Ciencias Sociales OA' : 'Revistas científicas OA',
          collectionCode: docType === 'book' ? 'oa-books' : 'oa-journals',
          year: w.publication_year ?? null,
          publicationDate: w.publication_date ?? undefined,
          language: inferLang(w.language, title),
          docType,
          oecdArea: finalArea,
          oecdSubarea: spec.subarea,
          abstract: abstract || `Obra de acceso abierto sobre ${spec.tag} (${publisher}).`,
          keywords: keywords.length ? keywords : [spec.tag, spec.subarea],
          doi,
          scieloUrl: landing,
          pdfUrl,
          citedByCount: w.cited_by_count ?? 0,
          sourceOrigin: 'openalex',
          categoryTag: spec.tag
        });
      }
    } catch {
      // ignore failed OpenAlex query
    }
  }
  return candidates;
}

/* -------------------------------------------------------------------------- */
/* Stage 4: Local un-uploaded seed-extra chunks matching philosophy / CO lit  */
/* -------------------------------------------------------------------------- */

function harvestLocalSeedExtra(): Candidate[] {
  const dir = path.join(OUT_DIR, 'seed-extra');
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^(doab|oa-books|redalyc)_(\d+)\.sql$/i.test(f))
    .filter((f) => {
      const m = /_(\d+)\.sql$/i.exec(f);
      return m ? Number(m[1]) >= 6 : false;
    })
    .sort();

  const TARGET_RE =
    /\b(foucault|immanuel kant|\bkant\b|karl marx|\bmarx\b|lenin|schopenhauer|edgar allan poe|nietzsche|spinoza|hegel|arist[oó]teles|plat[oó]n|descartes|rousseau|maquiavelo|garc[ií]a m[aá]rquez|jorge isaacs|eustasio rivera|carrasquilla|asunci[oó]n silva|rafael pombo|[aá]lvaro mutis|andr[eé]s caicedo|fernando vallejo|marvel moreno|le[oó]n de greiff|literatura colombiana|novela colombiana|poes[ií]a colombiana)\b/i;

  const out: Candidate[] = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of splitStatements(content)) {
      const row = parseInsertLine(stmt);
      if (!row) continue;
      const area = String(row.oecd_area || '');
      if (area !== 'humanities' && area !== 'social-sciences') continue;
      const titleAndAbs = `${row.title || ''} ${row.abstract || ''}`;
      if (!TARGET_RE.test(titleAndAbs) || CLINICAL_NOISE.test(titleAndAbs) || JUNK_DOC.test(titleAndAbs)) continue;
      const pdfUrl = String(row.pdf_url || '');
      const scieloUrl = String(row.scielo_url || '');
      if (!pdfUrl || !scieloUrl) continue;

      let authors: string[] = [];
      let keywords: string[] = [];
      try {
        authors = JSON.parse(String(row.authors_json || '[]')) as string[];
      } catch {
        authors = [];
      }
      try {
        keywords = JSON.parse(String(row.keywords_json || '[]')) as string[];
      } catch {
        keywords = [];
      }

      const tagMatch = TARGET_RE.exec(titleAndAbs)?.[1] || 'Filosofía / Literatura';
      out.push({
        id: String(row.id),
        title: String(row.title),
        subtitle: row.subtitle ? String(row.subtitle) : undefined,
        authors,
        publisher: String(row.publisher || 'Acceso Abierto'),
        country: String(row.country || 'Internacional'),
        collection: String(row.collection || 'DOAB · OAPEN'),
        collectionCode: String(row.collection_code || 'doab'),
        year: typeof row.publication_year === 'number' ? row.publication_year : null,
        publicationDate: row.publication_date ? String(row.publication_date) : undefined,
        language: inferLang(row.language, String(row.title)),
        docType: (row.doc_type as DocumentType) || 'book',
        oecdArea: area as OecdAreaId,
        oecdSubarea: row.oecd_subarea ? String(row.oecd_subarea) : undefined,
        abstract: String(row.abstract || ''),
        keywords,
        doi: row.doi ? String(row.doi) : undefined,
        isbn: row.isbn ? String(row.isbn) : undefined,
        scieloUrl,
        pdfUrl,
        citedByCount: typeof row.cited_by_count === 'number' ? row.cited_by_count : 0,
        sourceOrigin: (row.source_origin as 'oai-pmh' | 'opds' | 'openalex') || 'oai-pmh',
        categoryTag: `Local:${tagMatch.toLowerCase()}`
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Main pipeline                                                              */
/* -------------------------------------------------------------------------- */

async function main() {
  ensureDirs();
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);

  const existing = loadRemoteExisting();
  log(`Remote existing D1 works loaded: ${existing.ids.size} IDs, ${existing.titles.size} titles`);

  const [mia, ia, oa, localExtra] = await Promise.all([
    harvestMia().then((r) => {
      log(`Stage 1 (Marxists.org): ${r.length} raw candidates`);
      return r;
    }),
    harvestInternetArchive().then((r) => {
      log(`Stage 2 (Archive.org): ${r.length} raw candidates`);
      return r;
    }),
    harvestOpenAlexTargeted().then((r) => {
      log(`Stage 3 (OpenAlex OA): ${r.length} raw candidates`);
      return r;
    }),
    Promise.resolve(harvestLocalSeedExtra()).then((r) => {
      log(`Stage 4 (Local seed-extra): ${r.length} raw candidates`);
      return r;
    })
  ]);

  localExtra.sort((a, b) => (a.docType === 'book' ? 0 : 1) - (b.docType === 'book' ? 0 : 1));
  const combined = [...ia, ...mia, ...oa, ...localExtra];

  const deduped: Candidate[] = [];
  const seenTitles = new Set(existing.titles);
  const seenNormalizedWorks = new Set<string>();
  const seenIds = new Set(existing.ids);
  const seenDois = new Set(existing.dois);
  const seenPdfUrls = new Set<string>();

  for (const c of combined) {
    if (seenIds.has(c.id)) continue;
    const nt = normTitle(c.title);
    if (!nt || seenTitles.has(nt)) continue;
    const workKey = `${c.language}|${dedupeTitleKey(c.title, c.authors)}`;
    if (workKey.length > 4 && seenNormalizedWorks.has(workKey)) continue;
    if (c.doi) {
      const d = normalizeDoi(c.doi);
      if (d && seenDois.has(d)) continue;
      if (d) seenDois.add(d);
    }
    if (seenPdfUrls.has(c.pdfUrl)) continue;
    seenIds.add(c.id);
    seenTitles.add(nt);
    if (workKey.length > 4) seenNormalizedWorks.add(workKey);
    seenPdfUrls.add(c.pdfUrl);
    deduped.push(c);
  }
  log(`Deduplicated candidates to live-verify: ${deduped.length}`);

  const verified: Candidate[] = [];
  const hostOk: Record<string, number> = {};
  const hostFail: Record<string, number> = {};

  await mapPool(deduped, 10, async (c) => {
    const res = await verifyPdfStream(c.pdfUrl);
    const h = (() => {
      try {
        return new URL(c.pdfUrl).hostname.toLowerCase();
      } catch {
        return 'invalid';
      }
    })();
    if (res.ok && res.finalHost) {
      const allowOk =
        TRUSTED_EXISTING_HOSTS.test(res.finalHost) || CANDIDATE_NEW_HOSTS.test(res.finalHost);
      if (!allowOk) {
        hostFail[res.finalHost] = (hostFail[res.finalHost] || 0) + 1;
        return;
      }
      hostOk[h] = (hostOk[h] || 0) + 1;
      if (res.finalHost !== h) hostOk[res.finalHost] = (hostOk[res.finalHost] || 0) + 1;
      verified.push(c);
    } else {
      hostFail[h] = (hostFail[h] || 0) + 1;
    }
  });

  log(`Live %PDF- verified: ${verified.length}/${deduped.length}`);

  const finalPubs: Array<{ pub: Publication; tag: string }> = [];
  for (const c of verified) {
    const clean = sanitizePublication({
      id: c.id,
      oaiIdentifier: c.id,
      title: c.title,
      subtitle: c.subtitle,
      authors: c.authors,
      publisher: c.publisher,
      country: c.country,
      collection: c.collection,
      collectionCode: c.collectionCode,
      year: c.year,
      publicationDate: c.publicationDate,
      language: c.language,
      docType: c.docType,
      oecdArea: c.oecdArea,
      oecdSubarea: c.oecdSubarea,
      abstract: c.abstract,
      keywords: c.keywords,
      doi: c.doi,
      isbn: c.isbn,
      scieloUrl: 'https://doi.org/placeholder',
      citedByCount: c.citedByCount,
      sourceOrigin: c.sourceOrigin
    });
    if (!clean) continue;
    clean.country = c.country;
    clean.scieloUrl = c.scieloUrl;
    clean.pdfUrl = c.pdfUrl;
    finalPubs.push({ pub: clean, tag: c.categoryTag });
  }

  const capped = finalPubs.slice(0, 900);

  fs.mkdirSync(BATCH_DIR, { recursive: true });
  for (const f of fs.readdirSync(BATCH_DIR)) {
    if (/^curated_\d+\.sql$/.test(f)) fs.rmSync(path.join(BATCH_DIR, f));
  }

  const chunkSize = 200;
  const files: string[] = [];
  for (let i = 0; i < capped.length; i += chunkSize) {
    const lines = capped.slice(i, i + chunkSize).map(({ pub }) => insertStatement(pub, true));
    const name = `curated_${String(files.length + 1).padStart(3, '0')}.sql`;
    fs.writeFileSync(path.join(BATCH_DIR, name), lines.join('\n') + '\n', 'utf8');
    files.push(name);
  }

  const tally = (fn: (x: { pub: Publication; tag: string }) => string) => {
    const m: Record<string, number> = {};
    for (const x of capped) m[fn(x)] = (m[fn(x)] || 0) + 1;
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
  };

  const report = {
    generatedAt: new Date().toISOString(),
    totalVerified: finalPubs.length,
    totalWritten: capped.length,
    chunks: files,
    byCategoryTag: tally((x) => x.tag),
    byCollection: tally((x) => x.pub.collectionCode),
    byLanguage: tally((x) => x.pub.language),
    byCountry: tally((x) => x.pub.country || 'Internacional'),
    byDocType: tally((x) => x.pub.docType),
    byOecdArea: tally((x) => x.pub.oecdArea),
    verifiedHosts: Object.keys(hostOk).sort(),
    hostFailures: hostFail
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  log(`Wrote ${capped.length} works across ${files.length} chunks in ${BATCH_DIR}`);
  log(`Report: ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
