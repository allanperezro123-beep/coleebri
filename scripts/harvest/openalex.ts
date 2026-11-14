/** OpenAlex: works with DOI prefix 10.7476 (SciELO Books), cursor paginated, resumable. */
import { appendJsonl, loadState, readJsonl, saveState } from './cache';
import { fetchWithRetry, QuotaError } from './http';
import {
  decodeEntities,
  emptyRec,
  normalizeDoi,
  pickPdf,
  scieloIdFromUrl,
  scieloLanding,
  squash,
  type DocType,
  type Rec
} from './model';

const SELECT = [
  'id',
  'doi',
  'title',
  'type',
  'publication_year',
  'publication_date',
  'language',
  'primary_location',
  'best_oa_location',
  'open_access',
  'locations',
  'authorships',
  'abstract_inverted_index',
  'cited_by_count',
  'keywords',
  'primary_topic'
].join(',');

interface OaLocation {
  landing_page_url?: string | null;
  pdf_url?: string | null;
  source?: { display_name?: string | null } | null;
}

interface OaWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  type?: string;
  publication_year?: number | null;
  publication_date?: string | null;
  language?: string | null;
  primary_location?: OaLocation | null;
  best_oa_location?: OaLocation | null;
  open_access?: { oa_url?: string | null } | null;
  locations?: OaLocation[] | null;
  authorships?: Array<{ author?: { display_name?: string } | null }> | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  cited_by_count?: number;
  keywords?: Array<{ display_name?: string }> | null;
  primary_topic?: { field?: { display_name?: string }; domain?: { id?: string } } | null;
}

export function abstractFromInverted(index: Record<string, number[]> | null | undefined): string {
  if (!index) return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return squash(decodeEntities(words.filter((w) => w !== undefined).join(' ')));
}

function cleanPublisher(name: string | null | undefined): string | undefined {
  const cleaned = squash(name || '').replace(/\s+e-?books?$/i, '').trim();
  return cleaned || undefined;
}

export function normalizeWork(w: OaWork, docType: DocType): Rec | null {
  const title = squash(w.title || '');
  if (!title) return null;
  const oaId = w.id.split('/').pop() || '';
  const doi = normalizeDoi(w.doi);
  const locs = [w.primary_location, w.best_oa_location, ...(w.locations || [])].filter(Boolean) as OaLocation[];
  const urls = [
    ...locs.flatMap((l) => [l.pdf_url, l.landing_page_url]),
    w.open_access?.oa_url
  ].filter(Boolean) as string[];
  const scieloId = urls.map(scieloIdFromUrl).find(Boolean);
  const pdf = pickPdf(
    [w.primary_location?.pdf_url, w.best_oa_location?.pdf_url, ...(w.locations || []).map((l) => l.pdf_url), w.open_access?.oa_url],
    docType
  );
  const publisher = cleanPublisher(w.primary_location?.source?.display_name || w.best_oa_location?.source?.display_name);
  const rec = emptyRec({
    title,
    docType,
    openalexId: oaId,
    doi,
    scieloId,
    publisher,
    authors: (w.authorships || []).map((a) => squash(a.author?.display_name || '')).filter(Boolean),
    year: w.publication_year ?? null,
    publicationDate: w.publication_date || undefined,
    language: (w.language || '').toLowerCase(),
    abstract: abstractFromInverted(w.abstract_inverted_index),
    keywords: (w.keywords || []).map((k) => squash(k.display_name || '')).filter(Boolean).slice(0, 12),
    cited: w.cited_by_count || 0,
    fieldName: w.primary_topic?.field?.display_name,
    domainId: w.primary_topic?.domain?.id,
    scieloUrl: scieloId ? scieloLanding(scieloId) : doi ? `https://doi.org/${doi}` : undefined,
    pdfUrl: pdf.url,
    origins: ['openalex']
  });
  // a chapter-only PDF on a book record is remembered so the landing step resolves the real full-book PDF
  if (pdf.chapterOnly && !pdf.url) (rec as Rec & { chapterOnlyPdf?: string }).chapterOnlyPdf = pdf.chapterOnly;
  return rec;
}

export interface OpenAlexResult {
  records: Rec[];
  quota?: string;
  pages: number;
}

/**
 * Pagination strategy. OpenAlex only allows `cursor=` beyond the first page WITH an API key
 * (OPENALEX_API_KEY). Anonymously we fall back to basic `page=N` paging (max 10,000 results per query),
 * run under two different sort orders and union the results, because ties in a single sort order can
 * otherwise drop/duplicate a few records between pages.
 */
export async function harvestOpenAlex(docType: 'book' | 'chapter', max: number, fresh: boolean): Promise<OpenAlexResult> {
  void fresh; // cache reset is handled by the caller (--fresh wipes the cache dir)
  const name = `openalex-${docType}`;
  const records = new Map<string, Rec>();
  for (const r of readJsonl<Rec>(name)) if (r.openalexId) records.set(r.openalexId, r);
  let quota: string | undefined;
  let pages = 0;

  const apiKey = (process.env.OPENALEX_API_KEY || '').trim();
  const keyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';
  const filter =
    docType === 'book'
      ? 'doi_starts_with:10.7476,type:book'
      : 'doi_starts_with:10.7476,type:book-chapter,has_pdf_url:true';
  const passes = apiKey
    ? [{ key: `${name}-cursor`, sort: '' }]
    : [
        { key: `${name}-pages-cited`, sort: 'cited_by_count:desc' },
        { key: `${name}-pages-date`, sort: 'publication_date:desc' }
      ];

  for (const pass of passes) {
    const st = (loadState()[pass.key] ||= {});
    if (st.done) continue;
    let cursor = st.cursor ?? (apiKey ? '*' : '1');
    while (cursor && records.size < max) {
      const paging = apiKey ? `cursor=${encodeURIComponent(cursor)}` : `page=${cursor}&sort=${pass.sort}`;
      const url = `https://api.openalex.org/works?filter=${filter}&per-page=200&${paging}&select=${SELECT}${keyParam}`;
      let res: Response;
      try {
        res = await fetchWithRetry(url, { timeoutMs: 60_000 });
      } catch (err) {
        if (err instanceof QuotaError) {
          quota = `OpenAlex quota exhausted (${err.message}); partial results kept, re-run later to resume`;
          break;
        }
        throw err;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        if (res.status === 429 || res.status === 403 || res.status === 401) {
          quota = `OpenAlex HTTP ${res.status}: ${body}`;
          break;
        }
        throw new Error(`OpenAlex HTTP ${res.status}: ${body}`);
      }
      const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
      const json = (await res.json()) as { meta?: { count?: number; next_cursor?: string | null }; results?: OaWork[] };
      const results = json.results || [];
      const batch: Rec[] = [];
      for (const w of results) {
        const rec = normalizeWork(w, docType);
        if (!rec || !rec.openalexId) continue;
        if (!records.has(rec.openalexId)) batch.push(rec);
        records.set(rec.openalexId, rec);
      }
      appendJsonl(name, batch);
      pages += 1;
      let next = '';
      if (apiKey) next = json.meta?.next_cursor || '';
      else {
        const page = Number(cursor);
        const total = json.meta?.count ?? 0;
        if (results.length >= 200 && page * 200 < Math.min(total, 10_000)) next = String(page + 1);
      }
      cursor = next;
      st.cursor = cursor || null;
      st.count = records.size;
      if (!cursor || !results.length) st.done = true;
      saveState({ ...loadState(), [pass.key]: st });
      console.log(`[openalex:${docType}] ${pass.key} page ${pages}: +${batch.length} (total ${records.size}) quotaLeft=${Number.isFinite(remaining) ? remaining : '?'}`);
      if (Number.isFinite(remaining) && remaining <= 2 && cursor) {
        quota = `OpenAlex anonymous budget nearly exhausted (x-ratelimit-remaining=${remaining}); stopped to keep partial results`;
        break;
      }
      if (st.done) break;
    }
    if (quota || records.size >= max) break;
  }
  return { records: [...records.values()].slice(0, max), quota, pages };
}
