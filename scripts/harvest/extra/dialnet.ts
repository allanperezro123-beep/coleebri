/**
 * Dialnet (Universidad de La Rioja) — OAI-PMH `https://dialnet.unirioja.es/oai/OAIHandler`.
 *
 * Verified behaviour (2026-11):
 *  - Only `oai_dc`; the repository ("DIALNET OAI Articles") exposes ARTICLES only (no books, no theses).
 *  - Sets are the 13 Dialnet subject areas (20 = Psicología y educación, 19 = Ciencias sociales, 21 = Humanidades ...).
 *  - Every exposed record carries `dc:format application/pdf`; the free full text lives at
 *    https://dialnet.unirioja.es/descarga/articulo/<codigo>.pdf  (codigo = `servlet/oaiart?codigo=<n>` in dc:identifier).
 *  - Pages hold 100 records. Resumption tokens are STATELESS (`from!until!set!offset!oai_dc`), so we can jump to any
 *    offset: we sample evenly spaced windows across every set instead of reading only the oldest records, then rank.
 */
import { appendJsonl, loadState, readJsonl, saveState } from '../cache';
import { emptyRec, normalizeDoi, type Rec } from '../model';
import { HttpStatusError, QuotaError, TlsError } from '../http';
import { countryFromText, dcAll, langFromIso, pdfPassRate, plain, yearOf, type SourceReport, type SourceResult } from './common';
import { oaiGet, parseListRecords, identify } from './oai';

const BASE = 'https://dialnet.unirioja.es/oai/OAIHandler';
const SOURCE = 'dialnet';
export const DIALNET_ALLOW = /^dialnet\.unirioja\.es$/i;

/** setSpec → share of the scan budget (education first; the library is for teachers and social-science readers). */
const SET_PLAN: Array<{ set: string; name: string; share: number }> = [
  { set: '20', name: 'Psicología y educación', share: 0.35 },
  { set: '19', name: 'Ciencias sociales', share: 0.2 },
  { set: '21', name: 'Humanidades', share: 0.15 },
  { set: '23', name: 'Filologías', share: 0.1 },
  { set: '18', name: 'Ciencias jurídicas', share: 0.07 },
  { set: '17', name: 'Economía y empresa', share: 0.07 },
  { set: '22', name: 'Arte', share: 0.06 }
];
const PAGE = 100;
const WINDOW_PAGES = 5;

function token(set: string, offset: number): string {
  return `0001-01-01!9999-12-31!${set}!${offset}!oai_dc`;
}

export function mapDialnetRecord(xml: string, set: string): Rec | null {
  const ids = dcAll(xml, 'identifier').map((x) => x.value);
  const codigo = ids.map((i) => /oaiart\?codigo=(\d+)/.exec(i)?.[1]).find(Boolean);
  if (!codigo) return null;
  const type = (dcAll(xml, 'type')[0]?.value || '').toLowerCase();
  if (type && !/article|art[ií]culo/.test(type)) return null; // books/theses/chapters are not served by this OAI anyway
  if (!dcAll(xml, 'format').some((f) => /application\/pdf/i.test(f.value))) return null; // no evidence of full text
  const title = dcAll(xml, 'title')[0]?.value;
  if (!title || title.length < 3) return null;
  const source = dcAll(xml, 'source')[0]?.value || '';
  const journal = source.split(/,\s*ISSN\b/i)[0]?.split(/:/)[0]?.trim() || source.split(',')[0]?.trim();
  const pages = /pags?\.\s*(\d+)\s*-\s*(\d+)/i.exec(source);
  const pageCount = pages && Number(pages[2]) >= Number(pages[1]) ? Number(pages[2]) - Number(pages[1]) + 1 : undefined;
  const doi = ids.map((i) => normalizeDoi(i.match(/10\.\d{4,9}\/\S+/)?.[0])).find(Boolean);
  const descriptions = dcAll(xml, 'description').map((d) => d.value);
  const lang = langFromIso(dcAll(xml, 'language')[0]?.value);
  const rec = emptyRec({
    title,
    docType: 'article',
    externalId: `dialnet-${codigo}`,
    collection: 'Dialnet',
    collectionCode: 'dialnet',
    authors: dcAll(xml, 'creator').map((c) => c.value),
    publisher: dcAll(xml, 'publisher')[0]?.value || journal || undefined,
    journal: journal || undefined,
    year: yearOf(dcAll(xml, 'date')[0]?.value),
    language: lang,
    abstract: descriptions[0] || '',
    keywords: [...new Set(dcAll(xml, 'subject').map((s) => s.value))].slice(0, 15),
    doi,
    pageCount,
    setSpec: set,
    scieloUrl: `https://dialnet.unirioja.es/servlet/articulo?codigo=${codigo}`,
    pdfUrl: `https://dialnet.unirioja.es/descarga/articulo/${codigo}.pdf`,
    origins: ['oai-pmh']
  });
  return rec;
}

/** Number of records of a set, to ~20k precision (tokens are stateless, an offset past the end returns nothing). */
async function setSize(set: string, state: ReturnType<typeof loadState>): Promise<number> {
  const key = `extra:dialnet:size:${set}`;
  if (state[key]?.count) return state[key].count!;
  const nonEmpty = async (offset: number): Promise<boolean> => {
    const { xml } = await oaiGet(BASE, { verb: 'ListRecords', resumptionToken: token(set, offset) });
    return parseListRecords(xml).records.length > 0;
  };
  let lo = 0;
  let hi = 25_000;
  while (hi < 8_000_000 && (await nonEmpty(hi))) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 20_000) {
    const mid = Math.floor((lo + hi) / 2 / PAGE) * PAGE;
    if (await nonEmpty(mid)) lo = mid;
    else hi = mid;
  }
  const size = lo + Math.floor((hi - lo) / 2);
  state[key] = { count: size, done: true };
  saveState(state);
  return size;
}

export interface DialnetOptions {
  cap: number;
  /** records scanned = cap × scanFactor, then ranked (Colombia / Latin America / education first) down to `cap` */
  scanFactor: number;
  log: (m: string) => void;
}

function rank(r: Rec): number {
  const c = countryFromText(r.journal, r.publisher);
  let s = 0;
  if (c === 'Colombia') s += 1000;
  else if (c && c !== 'España' && c !== 'Portugal') s += 400; // rest of Latin America
  else if (c === 'España') s += 100;
  if (r.setSpec === '20') s += 120;
  else if (r.setSpec === '19') s += 60;
  if (r.abstract.length > 200) s += 30;
  if (r.language === 'es') s += 25;
  s += Math.max(0, (r.year ?? 1990) - 1990) / 10;
  return s;
}

export async function harvestDialnet(opts: DialnetOptions): Promise<SourceResult> {
  const report: SourceReport = { source: 'Dialnet', endpoint: BASE, status: 'ok', note: '', harvested: 0 };
  const state = loadState();
  const stop = (status: SourceReport['status'], note: string): SourceResult => {
    report.status = status;
    report.note = note;
    return { report, records: [], allow: DIALNET_ALLOW };
  };

  const id = await identify(BASE);
  if (!id.ok) return stop('unreachable', `Identify failed: ${id.detail}`);
  opts.log(`Dialnet: ${id.name} reachable`);

  const budget = opts.cap * opts.scanFactor;
  const seen = new Set(readJsonl<Rec>('extra-dialnet').map((r) => r.externalId));
  let scanned = 0;
  let gateDone = Boolean(state['extra:dialnet:gate']?.done);

  try {
    for (const plan of SET_PLAN) {
      const size = await setSize(plan.set, state);
      const setBudget = Math.round(budget * plan.share);
      const windows = Math.max(1, Math.ceil(setBudget / (WINDOW_PAGES * PAGE)));
      opts.log(`Dialnet set ${plan.set} (${plan.name}): ~${size.toLocaleString('en')} records, ${windows} windows of ${WINDOW_PAGES} pages`);
      for (let w = 0; w < windows; w += 1) {
        const key = `extra:dialnet:${plan.set}:${w}:${windows}`;
        if (state[key]?.done) {
          scanned += WINDOW_PAGES * PAGE;
          continue;
        }
        const start = Math.floor(((w + 0.5) * size) / windows / PAGE) * PAGE;
        let offset = Number(state[key]?.cursor ?? start);
        for (let p = Math.floor((offset - start) / PAGE); p < WINDOW_PAGES; p += 1) {
          const { xml } = await oaiGet(BASE, { verb: 'ListRecords', resumptionToken: token(plan.set, offset) });
          const page = parseListRecords(xml);
          if (page.error && page.error !== 'noRecordsMatch') throw new Error(`OAI error ${page.error}`);
          const fresh: Rec[] = [];
          for (const rx of page.records) {
            const rec = mapDialnetRecord(rx, plan.set);
            if (rec && !seen.has(rec.externalId)) {
              seen.add(rec.externalId);
              fresh.push(rec);
            }
          }
          appendJsonl('extra-dialnet', fresh);
          scanned += PAGE;
          offset += PAGE;
          state[key] = { cursor: String(offset), done: false };
          saveState(state);
          if (!gateDone && fresh.length >= 8) {
            const g = await pdfPassRate(fresh.slice(0, 8).map((f) => f.pdfUrl!), 8);
            opts.log(`Dialnet early PDF gate: ${g.ok}/${g.tested}`);
            if (g.rate < 0.5) return stop('dropped', `Early gate: only ${g.ok}/${g.tested} sample PDFs returned %PDF- (${g.failures.join('; ')})`);
            gateDone = true;
            state['extra:dialnet:gate'] = { done: true };
            saveState(state);
          }
          if (page.records.length < PAGE) break;
        }
        state[key] = { cursor: String(offset), done: true };
        saveState(state);
        if (w % 5 === 4) opts.log(`Dialnet set ${plan.set}: window ${w + 1}/${windows}, ${seen.size} records so far`);
      }
    }
  } catch (err) {
    if (err instanceof TlsError || err instanceof QuotaError) {
      report.note = `stopped early: ${(err as Error).message}. `;
    } else if (err instanceof HttpStatusError || err instanceof Error) {
      report.note = `stopped early (resumable): ${err.message.slice(0, 120)}. `;
    }
  }

  const all = readJsonl<Rec>('extra-dialnet');
  const byId = new Map<string, Rec>();
  for (const r of all) byId.set(r.externalId!, r);
  const ranked = [...byId.values()].sort((a, b) => rank(b) - rank(a));
  const kept = ranked.slice(0, opts.cap);
  report.scanned = byId.size;
  report.harvested = kept.length;
  report.note += `OAI-PMH oai_dc, ${SET_PLAN.length} subject sets sampled in evenly spaced windows; ${byId.size} records with full text scanned, top ${kept.length} kept (Colombia/Latin America/education ranked first).`;
  return { report, records: kept, allow: DIALNET_ALLOW };
}

export { plain };
