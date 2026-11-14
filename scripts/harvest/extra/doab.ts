/**
 * DOAB (Directory of Open Access Books) + OAPEN Library.
 *
 *  Stage A — OAPEN OAI-PMH (`https://library.oapen.org/oai/request`, metadataPrefix=xoai): DSpace xoai lists the real
 *            ORIGINAL PDF bitstream and the THUMBNAIL of each item (language, ISBN, DOI, publisher included).
 *            The OAPEN REST API (`/rest/...`) answers 403 "address not allowed" to every client we tried.
 *  Stage B — DOAB OAI-PMH (`https://directory.doabooks.org/oai/request`, oai_dc, set com_20.500.12854_5 "Books"):
 *            DOAB is a *directory*; its `dc:identifier`s mostly point to publisher pages/DOIs. We only keep records
 *            whose identifier is itself a direct `.pdf` URL, on publisher hosts that pass a live PDF check.
 *
 *  Both stages are gated by a live "%PDF-" Range probe: if the files cannot be fetched programmatically the stage is
 *  dropped. Nothing here tries to defeat bot protection.
 */
import { appendJsonl, loadState, readJsonl, saveState } from '../cache';
import { QuotaError, TlsError } from '../http';
import { emptyRec, normalizeDoi, normalizeIsbns, type Rec } from '../model';
import { hostOf, langFromIso, pdfPassRate, probeImageSize, probePdf, sampleRandom, yearOf, dcAll, type SourceReport, type SourceResult } from './common';
import { all, allPrefix, bestPdf, endsWithKey, first, parseXoai, thumbnail } from './dspace';
import { identify, oaiGet, parseListRecords } from './oai';

const OAPEN_BASE = 'https://library.oapen.org/oai/request';
const DOAB_BASE = 'https://directory.doabooks.org/oai/request';
const OAPEN_HOST = /^(?:[a-z0-9-]+\.)*oapen\.org$/i;
const DOAB_HOST = /^(?:[a-z0-9-]+\.)*doabooks\.org$/i;

export interface DoabOptions {
  cap: number;
  /** max English-language records kept (es/pt are never capped) */
  capEnglish: number;
  /** max OAI pages scanned in the DOAB directory stage (100 records each) */
  doabPages: number;
  log: (m: string) => void;
}

const handleSlug = (h: string) => h.replace(/[^A-Za-z0-9.]+/g, '-');

export function mapOapenRecord(recordXml: string): Rec | null {
  const x = parseXoai(recordXml);
  if (!x.handle) return null;
  const type = (first(x, 'dc.type') || '').toLowerCase();
  const docType = type === 'book' ? 'book' : type === 'chapter' ? 'chapter' : null;
  if (!docType) return null;
  const pdf = bestPdf(x);
  if (!pdf) return null;
  const thumb = thumbnail(x);
  const title = (first(x, 'dc.title') || '').replace(/^Chapter\s+/i, '');
  if (title.length < 3) return null;
  const alt = first(x, 'dc.title.alternative');
  const isbns = normalizeIsbns(all(x, 'oapen.relation.isbn'));
  const kw = all(x, 'dc.subject.other').flatMap((s) => s.split(/[;,]\s*/)).filter((s) => s && !/^thema|^bic|^bisac/i.test(s));
  return emptyRec({
    title,
    subtitle: alt,
    docType,
    externalId: `doab-${handleSlug(x.handle)}`,
    collection: 'DOAB · OAPEN',
    collectionCode: 'doab',
    authors: allPrefix(x, 'dc.contributor').slice(0, 25),
    publisher: endsWithKey(x, 'publisher.name') || first(x, 'oapen.imprint', 'dc.publisher'),
    year: yearOf(first(x, 'dc.date.issued')),
    language: langFromIso(first(x, 'dc.language')),
    abstract: first(x, 'dc.description.abstract') || first(x, 'oapen.abstract.otherlanguage') || '',
    keywords: [...new Set(kw)].slice(0, 15),
    doi: normalizeDoi(first(x, 'oapen.identifier.doi')),
    isbns,
    pageCount: Number(first(x, 'oapen.pages')) || undefined,
    scieloUrl: `https://library.oapen.org/handle/${x.handle}`,
    pdfUrl: pdf.url,
    coverUrl: thumb?.url,
    origins: ['oai-pmh']
  });
}

export function mapDoabDirectRecord(recordXml: string): Rec | null {
  const handle = /<identifier>oai:directory\.doabooks\.org:([^<]+)<\/identifier>/.exec(recordXml)?.[1];
  if (!handle) return null;
  const urls = dcAll(recordXml, 'identifier').map((i) => i.value).filter((v) => /^https?:\/\//i.test(v));
  const pdf = urls.find((u) => /\.pdf(\?|$)/i.test(u.split('#')[0]));
  if (!pdf) return null;
  const lang = langFromIso(dcAll(recordXml, 'language')[0]?.value);
  const title = dcAll(recordXml, 'title')[0]?.value;
  if (!title) return null;
  const alts = dcAll(recordXml, 'alternateIdentifier');
  const issued = dcAll(recordXml, 'date').find((d) => /Issued/i.test(d.attrs))?.value;
  return emptyRec({
    title,
    docType: 'book',
    externalId: `doab-${handleSlug(handle)}`,
    collection: 'DOAB · OAPEN',
    collectionCode: 'doab',
    authors: dcAll(recordXml, 'creator').map((c) => c.value).slice(0, 25),
    publisher: dcAll(recordXml, 'publisher')[0]?.value,
    year: yearOf(issued),
    language: lang,
    abstract: dcAll(recordXml, 'description')[0]?.value || '',
    keywords: dcAll(recordXml, 'subject').map((s) => s.value).filter((s) => !/^thema\b|^bic\b|^bisac\b/i.test(s)).slice(0, 15),
    doi: normalizeDoi(alts.find((a) => /DOI/i.test(a.attrs))?.value),
    isbns: normalizeIsbns(alts.filter((a) => /ISBN/i.test(a.attrs)).map((a) => a.value)),
    scieloUrl: `https://directory.doabooks.org/handle/${handle}`,
    pdfUrl: pdf,
    origins: ['oai-pmh']
  });
}

function wanted(r: Rec, enKept: { n: number }, capEn: number): boolean {
  const l = langFromIso(r.language);
  if (l === 'es' || l === 'pt') return true;
  if (l === 'en' && enKept.n < capEn) {
    enKept.n += 1;
    return true;
  }
  return false;
}

async function harvestOapenStage(opts: DoabOptions, state: ReturnType<typeof loadState>, notes: string[]): Promise<{ records: Rec[]; scanned: number; cover?: string }> {
  const KEY = 'extra:oapen';
  const have = new Map(readJsonl<Rec>('extra-oapen').map((r) => [r.externalId!, r]));
  const enKept = { n: [...have.values()].filter((r) => langFromIso(r.language) === 'en').length };
  let scanned = 0;
  let cover: string | undefined;

  const id = await identify(OAPEN_BASE);
  if (!id.ok) {
    notes.push(`OAPEN OAI unreachable: ${id.detail}.`);
    return { records: [], scanned };
  }
  if (state[`${KEY}:dropped`]?.done) {
    notes.push(String(state[`${KEY}:dropped`].note));
    return { records: [], scanned };
  }
  let token = state[KEY]?.cursor || undefined;
  let gate = Boolean(state[`${KEY}:gate`]?.done);
  try {
    for (let page = 0; page < 400 && have.size < opts.cap; page += 1) {
      const params = token ? { verb: 'ListRecords', resumptionToken: token } : { verb: 'ListRecords', metadataPrefix: 'xoai' };
      const { xml } = await oaiGet(OAPEN_BASE, params as Record<string, string>);
      const parsed = parseListRecords(xml);
      if (parsed.error === 'badResumptionToken') {
        token = undefined;
        continue;
      }
      const mapped = parsed.records.map(mapOapenRecord).filter((r): r is Rec => Boolean(r));
      scanned += parsed.records.length;
      if (!gate && mapped.length >= 8) {
        const g = await pdfPassRate(mapped.map((m) => m.pdfUrl!), 8);
        opts.log(`OAPEN bitstream gate: ${g.ok}/${g.tested}${g.failures[0] ? ` (${g.failures[0]})` : ''}`);
        if (g.rate < 0.5) {
          const note = `OAPEN bitstreams are not fetchable programmatically: ${g.ok}/${g.tested} sample PDFs returned %PDF- (${g.failures.slice(0, 2).join('; ')}). Stage dropped, no bypass attempted.`;
          state[`${KEY}:dropped`] = { done: true, note };
          saveState(state);
          notes.push(note);
          return { records: [], scanned };
        }
        gate = true;
        state[`${KEY}:gate`] = { done: true };
        const t = mapped.find((m) => m.coverUrl)?.coverUrl;
        if (t) {
          const img = await probeImageSize(t);
          cover = img.ok ? `${t} → ${img.type} ${img.width ?? '?'}x${img.height ?? '?'} px` : `${t} → not fetchable (${img.detail})`;
        }
      }
      const fresh = mapped.filter((r) => !have.has(r.externalId!) && wanted(r, enKept, opts.capEnglish));
      for (const r of fresh) have.set(r.externalId!, r);
      appendJsonl('extra-oapen', fresh);
      token = parsed.token;
      state[KEY] = { cursor: token ?? null, done: !token };
      saveState(state);
      if (page % 10 === 9) opts.log(`OAPEN page ${page + 1}: ${have.size} kept`);
      if (!token) break;
    }
  } catch (err) {
    notes.push(`OAPEN stage stopped (resumable): ${(err as Error).message.slice(0, 100)}.`);
    if (err instanceof TlsError || err instanceof QuotaError) notes.push('TLS/quota failure.');
  }
  return { records: [...have.values()], scanned, cover };
}

async function harvestDoabDirectStage(opts: DoabOptions, state: ReturnType<typeof loadState>, notes: string[]): Promise<{ records: Rec[]; scanned: number }> {
  const KEY = 'extra:doab-dir';
  const have = new Map(readJsonl<Rec>('extra-doab').map((r) => [r.externalId!, r]));
  const enKept = { n: [...have.values()].filter((r) => langFromIso(r.language) === 'en').length };
  let scanned = 0;
  const id = await identify(DOAB_BASE);
  if (!id.ok) {
    notes.push(`DOAB OAI unreachable: ${id.detail}.`);
    return { records: [], scanned };
  }
  let token = state[KEY]?.cursor || undefined;
  try {
    for (let page = Number(state[`${KEY}:pages`]?.count ?? 0); page < opts.doabPages; page += 1) {
      const params = token ? { verb: 'ListRecords', resumptionToken: token } : { verb: 'ListRecords', metadataPrefix: 'oai_dc', set: 'com_20.500.12854_5' };
      const { xml } = await oaiGet(DOAB_BASE, params as Record<string, string>);
      const parsed = parseListRecords(xml);
      if (parsed.error === 'badResumptionToken') {
        token = undefined;
        continue;
      }
      scanned += parsed.records.length;
      const fresh = parsed.records
        .map(mapDoabDirectRecord)
        .filter((r): r is Rec => Boolean(r))
        .filter((r) => !have.has(r.externalId!) && wanted(r, enKept, opts.capEnglish));
      for (const r of fresh) have.set(r.externalId!, r);
      appendJsonl('extra-doab', fresh);
      token = parsed.token;
      state[KEY] = { cursor: token ?? null, done: !token };
      state[`${KEY}:pages`] = { count: page + 1 };
      saveState(state);
      if (page % 25 === 24) opts.log(`DOAB directory page ${page + 1}/${opts.doabPages}: ${have.size} direct-PDF records kept`);
      if (!token) break;
    }
  } catch (err) {
    notes.push(`DOAB directory stage stopped (resumable): ${(err as Error).message.slice(0, 100)}.`);
  }
  return { records: [...have.values()], scanned };
}

export async function harvestDoab(opts: DoabOptions): Promise<SourceResult> {
  const report: SourceReport = {
    source: 'DOAB · OAPEN',
    endpoint: `${OAPEN_BASE} (xoai) + ${DOAB_BASE} (oai_dc)`,
    status: 'ok',
    note: '',
    harvested: 0
  };
  const state = loadState();
  const notes: string[] = [];

  const a = await harvestOapenStage(opts, state, notes);
  const b = await harvestDoabDirectStage(opts, state, notes);
  report.scanned = a.scanned + b.scanned;
  if (a.cover) notes.push(`OAPEN thumbnail: ${a.cover}.`);

  // Stage B: keep only publisher hosts with >= 3 candidate records AND a live %PDF- probe.
  let direct = b.records;
  const hostCount = new Map<string, Rec[]>();
  for (const r of direct) {
    const h = hostOf(r.pdfUrl);
    if (!h) continue;
    hostCount.set(h, [...(hostCount.get(h) ?? []), r]);
  }
  const goodHosts = new Set<string>();
  const badHosts: string[] = [];
  for (const [h, recs] of hostCount) {
    if (recs.length < 3) continue;
    const probe = await probePdf(sampleRandom(recs, 1)[0].pdfUrl!);
    if (probe.ok) goodHosts.add(h);
    else badHosts.push(`${h} (${probe.detail})`);
  }
  direct = direct.filter((r) => goodHosts.has(hostOf(r.pdfUrl) ?? ''));
  notes.push(
    `DOAB directory: ${b.scanned} records scanned, ${b.records.length} es/pt/en with a direct .pdf identifier, ${direct.length} kept on ${goodHosts.size} verified publisher hosts` +
      (badHosts.length ? `; hosts failing the PDF probe: ${badHosts.join(', ')}` : '') +
      '.'
  );

  const records = [...a.records, ...direct].slice(0, opts.cap);
  report.harvested = records.length;
  report.status = records.length ? 'ok' : 'dropped';
  report.note = notes.join(' ');
  const escaped = [...goodHosts].map((h) => h.replace(/[.]/g, '\\.'));
  const allow = new RegExp(`^(?:(?:[a-z0-9-]+\\.)*oapen\\.org|(?:[a-z0-9-]+\\.)*doabooks\\.org${escaped.length ? `|${escaped.join('|')}` : ''})$`, 'i');
  return { report, records, allow };
}

export { OAPEN_HOST, DOAB_HOST };
