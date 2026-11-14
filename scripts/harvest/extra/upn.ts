/**
 * Repositorio institucional de la Universidad Pedagógica Nacional (Colombia), DSpace.
 *
 * Findings (2026-11): the OAI identifiers are `oai:repository.pedagogica.edu.co:20.500.12209/<n>` and the site is
 * `repositorio.pedagogica.edu.co`, but both hostnames resolve to 200.119.126.32 and every connection (80/443, also
 * www.pedagogica.edu.co) times out from this network. The module probes the candidate OAI endpoints and, when one
 * answers, harvests it with the same xoai parser used for OAPEN (books, chapters and articles with a PDF bitstream;
 * student theses — tesis, trabajo de grado, bachelor/master/doctoral thesis — are always excluded).
 * When it is unreachable the source is reported as such and nothing is emitted (it is NOT retried aggressively).
 */
import { appendJsonl, loadState, readJsonl, saveState } from '../cache';
import { emptyRec, normalizeDoi, normalizeIsbns, type Rec } from '../model';
import { hostOf, langFromIso, pdfPassRate, yearOf, type SourceReport, type SourceResult } from './common';
import { all, allPrefix, bestPdf, endsWithKey, first, parseXoai, thumbnail } from './dspace';
import { identify, oaiGet, parseListRecords } from './oai';

const CANDIDATES = ['https://repository.pedagogica.edu.co/oai/request', 'https://repositorio.pedagogica.edu.co/oai/request', 'https://repositorio.pedagogica.edu.co/oai', 'https://repository.pedagogica.edu.co/oai/openaire'];
const THESIS = /thesis|tesis|trabajo de grado|trabajo de investigaci[oó]n|bachelor|master|doctoral|monograf[ií]a de grado|proyecto de grado|degree|disserta/i;
const PUBLISHED = /book|libro|bookpart|cap[ií]tulo|article|art[ií]culo|journal/i;

export interface UpnOptions {
  cap: number;
  log: (m: string) => void;
}

export function mapUpnRecord(recordXml: string, host: string): Rec | null {
  const x = parseXoai(recordXml);
  if (!x.handle) return null;
  const types = all(x, 'dc.type', 'dc.type.driver', 'dc.type.coar', 'dc.type.hasversion').join(' | ');
  if (THESIS.test(types) || !PUBLISHED.test(types)) return null;
  const pdf = bestPdf(x);
  if (!pdf) return null;
  const title = first(x, 'dc.title');
  if (!title) return null;
  const docType = /bookpart|cap[ií]tulo|chapter/i.test(types) ? 'chapter' : /article|art[ií]culo|journal/i.test(types) ? 'article' : 'book';
  const thumb = thumbnail(x);
  return emptyRec({
    title,
    docType,
    externalId: `upn-${x.handle.replace(/[^A-Za-z0-9.]+/g, '-')}`,
    collection: 'Repositorio UPN',
    collectionCode: 'upn',
    authors: allPrefix(x, 'dc.contributor').slice(0, 25),
    publisher: first(x, 'dc.publisher') || 'Universidad Pedagógica Nacional',
    year: yearOf(first(x, 'dc.date.issued', 'dc.date.created')),
    language: langFromIso(first(x, 'dc.language.iso', 'dc.language')),
    abstract: first(x, 'dc.description.abstract', 'dc.description') || '',
    keywords: all(x, 'dc.subject', 'dc.subject.keyword', 'dc.subject.proposal').slice(0, 15),
    doi: normalizeDoi(first(x, 'dc.identifier.doi') || endsWithKey(x, 'identifier.doi')),
    isbns: normalizeIsbns(all(x, 'dc.identifier.isbn')),
    scieloUrl: `https://${host}/handle/${x.handle}`,
    pdfUrl: pdf.url,
    coverUrl: thumb?.url,
    origins: ['oai-pmh']
  });
}

export async function harvestUpn(opts: UpnOptions): Promise<SourceResult> {
  const report: SourceReport = { source: 'Repositorio UPN', endpoint: CANDIDATES[0], status: 'unreachable', note: '', harvested: 0 };
  let base: string | undefined;
  const attempts: string[] = [];
  for (const c of CANDIDATES) {
    const r = await identify(c);
    attempts.push(`${c} → ${r.detail}`);
    if (r.ok) {
      base = c;
      break;
    }
    if (/ETIMEDOUT|CONNECT_TIMEOUT/.test(r.detail) && attempts.length >= 2) break; // same IP: no point in more timeouts
  }
  const allowHosts = /^(?:repository|repositorio)\.pedagogica\.edu\.co$/i;
  if (!base) {
    report.note = `OAI endpoint unreachable (${attempts.join(' | ')}). Both repository.pedagogica.edu.co and repositorio.pedagogica.edu.co resolve to 200.119.126.32 but the connection times out; nothing harvested.`;
    return { report, records: [], allow: allowHosts };
  }
  report.endpoint = base;
  report.status = 'ok';
  const host = new URL(base).hostname;
  const state = loadState();
  const have = new Map(readJsonl<Rec>('extra-upn').map((r) => [r.externalId!, r]));
  let token = state['extra:upn']?.cursor || undefined;
  let scanned = 0;
  try {
    for (let page = 0; page < 500 && have.size < opts.cap; page += 1) {
      const params = token ? { verb: 'ListRecords', resumptionToken: token } : { verb: 'ListRecords', metadataPrefix: 'xoai' };
      const { xml } = await oaiGet(base, params as Record<string, string>);
      const parsed = parseListRecords(xml);
      if (parsed.error) {
        report.note += `OAI error ${parsed.error}. `;
        if (parsed.error === 'badResumptionToken') token = undefined;
        else break;
        continue;
      }
      scanned += parsed.records.length;
      const fresh = parsed.records.map((r) => mapUpnRecord(r, host)).filter((r): r is Rec => Boolean(r) && !have.has(r!.externalId!));
      for (const r of fresh) have.set(r.externalId!, r);
      appendJsonl('extra-upn', fresh);
      token = parsed.token;
      state['extra:upn'] = { cursor: token ?? null, done: !token };
      saveState(state);
      if (!token) break;
    }
  } catch (err) {
    report.note += `stopped early (resumable): ${(err as Error).message.slice(0, 100)}. `;
  }
  const records = [...have.values()].slice(0, opts.cap);
  report.scanned = scanned;
  report.harvested = records.length;
  report.note += `DSpace xoai; theses excluded; ${records.length} published works with PDF bitstream.`;
  void hostOf;
  void pdfPassRate;
  return { report, records, allow: allowHosts };
}
