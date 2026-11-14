/** books.scielo.org landing-page scraping + doi.org → SciELO id resolution (both cached, resumable). */
import { appendJsonl, readJsonl } from './cache';
import { fetchWithRetry, mapPool } from './http';
import { isChapterPdf, normalizeDoi, normalizeIsbn, scieloCover, scieloIdFromUrl, squash, stripTags } from './model';

export interface LandingResult {
  id: string;
  ok: boolean;
  /** HTTP status when !ok (404 = book gone) or error text */
  error?: string;
  attempts: number;
  title?: string;
  pdfUrl?: string;
  epubUrl?: string;
  isbns?: string[];
  doi?: string;
  language?: string;
  pages?: number;
  year?: number;
  publisher?: string;
  coverUrl?: string;
  fetchedAt: string;
}

const LANG_MAP: Array<[RegExp, string]> = [
  [/portugu/i, 'pt'],
  [/espa[nñ]|spanish|castellano/i, 'es'],
  [/ingl[eê]s|english/i, 'en'],
  [/fran[cç]|french/i, 'fr']
];

function dd(html: string, label: RegExp): string | undefined {
  const m = new RegExp(`<dt>\\s*(?:${label.source})\\s*:?\\s*</dt>\\s*<dd>([\\s\\S]*?)</dd>`, 'i').exec(html);
  return m ? stripTags(m[1]) : undefined;
}

export function parseLanding(id: string, html: string): Omit<LandingResult, 'attempts' | 'fetchedAt'> {
  const hrefs = (ext: 'pdf' | 'epub') => {
    const re = new RegExp(`<a\\b[^>]*?href="(/id/${id}/${ext}/[^"]+\\.${ext})"[^>]*>`, 'gi');
    const found: Array<{ href: string; tag: string }> = [];
    for (let m = re.exec(html); m; m = re.exec(html)) found.push({ href: m[1], tag: m[0] });
    return found;
  };
  const pdfs = hrefs('pdf');
  // The "Book in PDF" anchor carries class="pdf_file"; chapter anchors have class="PDF" and a -NN suffix.
  const whole =
    pdfs.find((p) => /class="pdf_file"/i.test(p.tag))?.href ?? pdfs.find((p) => !isChapterPdf(p.href))?.href;
  const epub = hrefs('epub')[0]?.href;
  const isbns: string[] = [];
  for (const label of [/ISBN/, /eISBN/]) {
    const n = normalizeIsbn(dd(html, label) || '');
    if (n && !isbns.includes(n)) isbns.push(n);
  }
  const langText = dd(html, /Language|Idioma|L[ií]ngua/);
  const language = langText ? LANG_MAP.find(([re]) => re.test(langText))?.[1] ?? 'other' : undefined;
  const pages = Number(/\d+/.exec(dd(html, /Pages|P[aá]ginas?/) || '')?.[0]);
  const year = Number(/\d{4}/.exec(dd(html, /Year|A[nñ]o|Ano/) || '')?.[0]);
  const doiText = dd(html, /DOI/);
  const title = /<meta\s+name="citation_title"\s+content="([^"]*)"/i.exec(html)?.[1];
  return {
    id,
    ok: true,
    title: title ? stripTags(title) : undefined,
    pdfUrl: whole ? `https://books.scielo.org${whole}` : undefined,
    epubUrl: epub ? `https://books.scielo.org${epub}` : undefined,
    isbns,
    doi: normalizeDoi(doiText || ''),
    language,
    pages: Number.isFinite(pages) && pages > 0 ? pages : undefined,
    year: Number.isFinite(year) ? year : undefined,
    publisher: dd(html, /Publisher|Editora|Editorial/),
    coverUrl: html.includes(`/id/${id}/cover/`) ? scieloCover(id) : undefined
  };
}

const CACHE = 'landing';

export function loadLandingCache(): Map<string, LandingResult> {
  const map = new Map<string, LandingResult>();
  for (const r of readJsonl<LandingResult>(CACHE)) map.set(r.id, r);
  return map;
}

/** Fetches landing pages (max 3 concurrent; books.scielo.org spacing enforced by the http layer). */
export async function scrapeLandings(
  ids: string[],
  cache: Map<string, LandingResult>,
  onProgress?: (done: number, total: number) => void
): Promise<{ fetched: number; ok: number; failed: number }> {
  let done = 0;
  let ok = 0;
  let failed = 0;
  await mapPool(ids, 3, async (id) => {
    const prev = cache.get(id);
    let result: LandingResult;
    try {
      const res = await fetchWithRetry(`https://books.scielo.org/id/${id}`, { timeoutMs: 45_000, maxRetries: 3 });
      if (res.ok) {
        const html = await res.text();
        result = { ...parseLanding(id, html), attempts: (prev?.attempts ?? 0) + 1, fetchedAt: new Date().toISOString() };
        ok += 1;
      } else {
        // 404/410 are definitive; other statuses may be transient
        result = { id, ok: false, error: `HTTP ${res.status}`, attempts: (prev?.attempts ?? 0) + 1, fetchedAt: new Date().toISOString() };
        failed += 1;
      }
    } catch (err) {
      result = { id, ok: false, error: (err as Error).message.slice(0, 160), attempts: (prev?.attempts ?? 0) + 1, fetchedAt: new Date().toISOString() };
      failed += 1;
    }
    cache.set(id, result);
    appendJsonl(CACHE, [result]);
    done += 1;
    if (done % 25 === 0 || done === ids.length) onProgress?.(done, ids.length);
  });
  return { fetched: ids.length, ok, failed };
}

/* ----------------------- doi.org → books.scielo.org/id/<id> ----------------------- */

export interface DoiResolution {
  doi: string;
  id?: string;
  status: string;
}

const DOI_CACHE = 'doi-resolve';

export function loadDoiCache(): Map<string, DoiResolution> {
  const map = new Map<string, DoiResolution>();
  for (const r of readJsonl<DoiResolution>(DOI_CACHE)) map.set(r.doi, r);
  return map;
}

export async function resolveDois(dois: string[], cache: Map<string, DoiResolution>): Promise<{ resolved: number; failed: number }> {
  let resolved = 0;
  let failed = 0;
  await mapPool(dois, 3, async (doi) => {
    let out: DoiResolution;
    try {
      const res = await fetchWithRetry(`https://doi.org/${doi}`, { redirect: 'manual', timeoutMs: 20_000, maxRetries: 2 });
      const loc = res.headers.get('location') || '';
      const id = scieloIdFromUrl(loc);
      out = id ? { doi, id, status: String(res.status) } : { doi, status: `no-scielo-redirect:${res.status}` };
      if (id) resolved += 1;
      else failed += 1;
    } catch (err) {
      out = { doi, status: `error:${squash((err as Error).message).slice(0, 80)}` };
      failed += 1;
    }
    cache.set(doi, out);
    appendJsonl(DOI_CACHE, [out]);
  });
  return { resolved, failed };
}
