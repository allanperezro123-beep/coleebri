/**
 * Redalyc — Latin American journal articles.
 *
 * Verified behaviour (2026-11):
 *  - There is NO working public OAI-PMH endpoint: www.redalyc.org/oai[...] answers 404 and oai.redalyc.org
 *    times out on connect (the 2009-era base URL oai.redalyc.uaemex.mx is gone). Probed and dropped.
 *  - OpenAlex mirrors Redalyc's OAI feed as the repository source S4377196100 ("pmh:oai:redalyc.org:<id>") and keeps
 *    the real PDF location of many articles (https://www.redalyc.org/pdf/<journalId>/<articleId>.pdf). The journal id
 *    is NOT derivable from the article id, so we only keep works whose PDF URL OpenAlex actually knows (never guessed).
 *  - Redalyc itself is slow (4-13 s per request): we never scrape landing pages, we only Range-probe PDFs.
 *
 * Order: Colombian-affiliated works first (authorships.institutions.country_code:CO), then the rest of es/pt.
 */
import { appendJsonl, loadState, readJsonl, saveState } from '../cache';
import { fetchWithRetry, HttpStatusError, QuotaError, TlsError } from '../http';
import { emptyRec, normalizeDoi, stripTags, type Rec } from '../model';
import { langFromIso, type SourceReport, type SourceResult } from './common';

export const REDALYC_ALLOW = /^(?:www\.)?redalyc\.org$/i;
const REDALYC_SOURCE = 'S4377196100';
const SELECT = 'id,doi,title,publication_year,publication_date,language,locations,type,authorships,keywords,abstract_inverted_index,biblio,cited_by_count';

interface OaLocation {
  id?: string;
  landing_page_url?: string | null;
  pdf_url?: string | null;
  raw_source_name?: string | null;
}
interface OaWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  language?: string | null;
  type?: string | null;
  locations?: OaLocation[];
  authorships?: Array<{ author?: { display_name?: string } }>;
  keywords?: Array<{ display_name?: string }>;
  abstract_inverted_index?: Record<string, number[]> | null;
  biblio?: { first_page?: string; last_page?: string };
  cited_by_count?: number;
}

function abstractFrom(idx: OaWork['abstract_inverted_index']): string {
  if (!idx) return '';
  const words: string[] = [];
  for (const [w, positions] of Object.entries(idx)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(' ');
}

function nameCase(s: string): string {
  const t = s.trim();
  if (t.length > 3 && t === t.toUpperCase()) return t.toLowerCase().replace(/(^|[\s\-'’.(])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
  return t;
}
function titleCase(s: string): string {
  const t = s.trim();
  if (t.length > 8 && t === t.toUpperCase() && /\p{L}/u.test(t)) return t.charAt(0) + t.slice(1).toLowerCase();
  return t;
}

export function mapRedalycWork(w: OaWork): Rec | null {
  const type = (w.type || '').toLowerCase();
  if (type && type !== 'article') return null;
  let pdf: string | undefined;
  let artId: string | undefined;
  let raw = '';
  for (const l of w.locations || []) {
    for (const u of [l.pdf_url, l.landing_page_url]) {
      const m = u ? /^https?:\/\/(?:www\.)?redalyc\.org\/pdf\/(\d+)\/(\d+)\.pdf$/i.exec(u.trim()) : null;
      if (m) {
        pdf = `https://www.redalyc.org/pdf/${m[1]}/${m[2]}.pdf`;
        artId = m[2];
      }
    }
    if (l.id?.startsWith('pmh:oai:redalyc.org:')) {
      artId = artId || l.id.split(':').pop();
      raw = l.raw_source_name || raw;
    }
  }
  if (!pdf || !artId) return null;
  const title = titleCase(stripTags(w.title || ''));
  if (title.length < 5) return null;
  const lang = langFromIso(w.language || '');
  // "Revista X (Colombia) Vol.5 Num.2" → journal "Revista X", country text "(Colombia)"
  const journal = raw.replace(/\s*\([^)]*\)\s*(?:Vol\.|Num\.|N[uú]m|Vol|No\.).*$/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim() || undefined;
  const countryText = /\(([^)]+)\)/.exec(raw)?.[1];
  const pages = w.biblio?.first_page && w.biblio?.last_page ? Number(w.biblio.last_page) - Number(w.biblio.first_page) + 1 : NaN;
  return emptyRec({
    title,
    docType: 'article',
    externalId: `redalyc-${artId}`,
    collection: 'Redalyc',
    collectionCode: 'redalyc',
    authors: (w.authorships || []).map((a) => nameCase(a.author?.display_name || '')).filter(Boolean).slice(0, 25),
    publisher: journal,
    journal: [journal, countryText].filter(Boolean).join(' ') || undefined,
    year: w.publication_year ?? null,
    publicationDate: w.publication_date || undefined,
    language: lang,
    abstract: stripTags(abstractFrom(w.abstract_inverted_index)),
    keywords: (w.keywords || []).map((k) => k.display_name || '').filter(Boolean).slice(0, 15),
    doi: normalizeDoi(w.doi || undefined),
    pageCount: Number.isFinite(pages) && pages > 0 && pages < 2000 ? pages : undefined,
    cited: w.cited_by_count || 0,
    openalexId: w.id.replace('https://openalex.org/', ''),
    scieloUrl: `https://www.redalyc.org/articulo.oa?id=${artId}`,
    pdfUrl: pdf,
    origins: ['openalex']
  });
}

export interface RedalycOptions {
  cap: number;
  log: (m: string) => void;
}

export async function harvestRedalyc(opts: RedalycOptions): Promise<SourceResult> {
  const report: SourceReport = {
    source: 'Redalyc',
    endpoint: 'OpenAlex works mirror of Redalyc OAI (source S4377196100); native OAI not reachable',
    status: 'ok',
    note: '',
    harvested: 0
  };
  const state = loadState();
  const apiKey = (process.env.OPENALEX_API_KEY || '').trim();
  const have = new Map(readJsonl<Rec>('extra-redalyc').map((r) => [r.externalId!, r]));
  let scanned = 0;
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear - 1989 }, (_, i) => thisYear - i);

  const queries: Array<{ id: string; filter: (y: number) => string }> = [
    { id: 'co', filter: (y) => `locations.source.id:${REDALYC_SOURCE},authorships.institutions.country_code:CO,language:es|pt,type:article,publication_year:${y}` },
    { id: 'es', filter: (y) => `locations.source.id:${REDALYC_SOURCE},language:es,type:article,publication_year:${y}` },
    { id: 'pt', filter: (y) => `locations.source.id:${REDALYC_SOURCE},language:pt,type:article,publication_year:${y}` }
  ];

  try {
    outer: for (const q of queries) {
      for (const y of years) {
        if (have.size >= opts.cap) break outer;
        const key = `extra:redalyc:${q.id}:${y}`;
        if (state[key]?.done) continue;
        let page = Number(state[key]?.cursor ?? 1);
        for (; page <= 50; page += 1) {
          const url =
            `https://api.openalex.org/works?filter=${encodeURI(q.filter(y)).replace(/\|/g, '%7C')}&per-page=200&page=${page}&select=${SELECT}` +
            (apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '');
          const res = await fetchWithRetry(url, { timeoutMs: 60_000, maxRetries: 3 });
          if (res.status === 429 || res.status === 402 || res.status === 403) throw new QuotaError(`OpenAlex HTTP ${res.status} (daily budget)`, 86_400);
          if (!res.ok) throw new HttpStatusError(res.status, url);
          const body = (await res.json()) as { results?: OaWork[] };
          const works = body.results || [];
          const fresh: Rec[] = [];
          for (const w of works) {
            const r = mapRedalycWork(w);
            if (r && !have.has(r.externalId!)) {
              have.set(r.externalId!, r);
              fresh.push(r);
            }
          }
          appendJsonl('extra-redalyc', fresh);
          scanned += works.length;
          state[key] = { cursor: String(page + 1), done: false };
          saveState(state);
          if (works.length < 200 || have.size >= opts.cap) {
            if (works.length < 200) state[key] = { cursor: String(page + 1), done: true };
            break;
          }
        }
        if (page > 50) state[key] = { cursor: '51', done: true };
        saveState(state);
        opts.log(`Redalyc ${q.id} ${y}: ${have.size} kept (scanned ${scanned} works this run)`);
      }
    }
  } catch (err) {
    report.note = `stopped early (resumable): ${(err as Error).message.slice(0, 140)}. `;
    if (err instanceof TlsError) report.note = `TLS failure, source stopped: ${err.message}. `;
  }

  const records = [...have.values()].slice(0, opts.cap);
  report.scanned = scanned;
  report.harvested = records.length;
  report.note += `Works with a known https://www.redalyc.org/pdf/<journal>/<article>.pdf location (about 6-11% of Redalyc works in OpenAlex), Colombian affiliations first.`;
  return { report, records, allow: REDALYC_ALLOW };
}
