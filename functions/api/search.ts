import { rowToPublication, type Env, type PublicationRow } from '../types';
import { INSERT_NEW_PUBLICATION_SQL, bindPublication, sanitizePublication } from '../publications';
import { cacheKeyFor } from '../cache';
import {
  MAX_QUERY_LENGTH,
  SEARCH_WORD_CLAUSE,
  clampInt,
  ftsMatchQuery,
  isMissingFtsError,
  cleanText,
  fetchWithTimeout,
  json,
  politeUserAgent,
  searchWordParams,
  searchWords
} from '../security';
import { classifyOecdArea, inferCountry } from '../../src/lib/taxonomy';
import type { DocumentType, LanguageCode, Publication } from '../../src/types/publication';

interface OpenAlexWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  language?: string | null;
  type?: string | null;
  cited_by_count?: number;
  primary_location?: {
    landing_page_url?: string | null;
    pdf_url?: string | null;
    source?: {
      display_name?: string | null;
      host_organization_name?: string | null;
      country_code?: string | null;
    } | null;
  } | null;
  best_oa_location?: {
    landing_page_url?: string | null;
    pdf_url?: string | null;
  } | null;
  open_access?: {
    oa_url?: string | null;
  } | null;
  authorships?: Array<{
    author?: { display_name?: string | null } | null;
    raw_author_name?: string | null;
  }>;
  primary_topic?: {
    display_name?: string | null;
    field?: { display_name?: string | null } | null;
    domain?: { id?: string | null } | null;
  } | null;
  keywords?: Array<{ display_name?: string | null }>;
  abstract_inverted_index?: Record<string, number[]> | null;
}

function reconstructAbstract(inverted?: Record<string, number[]> | null): string {
  if (!inverted) return '';
  const words: string[] = [];
  for (const [token, positions] of Object.entries(inverted)) {
    for (const pos of positions) {
      words[pos] = token;
    }
  }
  return words.filter(Boolean).join(' ').trim();
}

function normalizeLanguage(lang?: string | null): LanguageCode {
  if (!lang) return 'es';
  const code = lang.toLowerCase().slice(0, 2);
  if (code === 'es' || code === 'pt' || code === 'en') return code;
  return 'other';
}

function normalizeDocType(type?: string | null): DocumentType {
  if (type === 'book') return 'book';
  if (type === 'book-chapter' || type === 'chapter') return 'chapter';
  return 'article';
}

function upgradeHttps(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('http://books.scielo.org/') || url.startsWith('http://www.scielo.') || url.startsWith('http://scielo.')) {
    return url.replace(/^http:\/\//, 'https://');
  }
  return url;
}

function extractScieloBookId(url?: string | null): string | null {
  if (!url) return null;
  const match = /books\.scielo\.org\/id\/([a-z0-9]+)/i.exec(url);
  return match ? match[1] : null;
}

function inferCollection(pdfUrl?: string, landingUrl?: string, sourceName?: string | null): { collection: string; code: string } {
  const combined = `${pdfUrl || ''} ${landingUrl || ''}`.toLowerCase();
  if (combined.includes('books.scielo.org')) return { collection: 'SciELO Books', code: 'books' };
  if (combined.includes('scielo.br')) return { collection: 'SciELO Brasil', code: 'scielo-br' };
  if (combined.includes('scielo.org.co')) return { collection: 'SciELO Colombia', code: 'scielo-co' };
  if (combined.includes('scielo.org.mx')) return { collection: 'SciELO México', code: 'scielo-mx' };
  if (combined.includes('scielo.cl')) return { collection: 'SciELO Chile', code: 'scielo-cl' };
  if (combined.includes('scielo.org.ar')) return { collection: 'SciELO Argentina', code: 'scielo-ar' };
  if (combined.includes('scielo.org.pe')) return { collection: 'SciELO Perú', code: 'scielo-pe' };
  if (combined.includes('scielo.isciii.es')) return { collection: 'SciELO España', code: 'scielo-es' };
  if (sourceName && sourceName.toLowerCase().includes('scielo')) {
    return { collection: sourceName, code: 'scielo-regional' };
  }
  return { collection: 'Red SciELO', code: 'scielo-network' };
}

function mapOpenAlexWork(work: OpenAlexWork): Publication {
  const rawPdf =
    work.primary_location?.pdf_url ||
    work.best_oa_location?.pdf_url ||
    (work.open_access?.oa_url?.includes('.pdf') ? work.open_access.oa_url : undefined);
  const pdfUrl = upgradeHttps(rawPdf);
  const landing = upgradeHttps(
    work.primary_location?.landing_page_url || work.best_oa_location?.landing_page_url || work.doi || work.id
  )!;
  const bookId = extractScieloBookId(pdfUrl || landing);
  const coverUrl = bookId ? `https://books.scielo.org/id/${bookId}/cover/cover_thumbnail.jpeg` : undefined;
  const scieloUrl = bookId ? `https://books.scielo.org/id/${bookId}` : landing;

  const title = (work.title || work.display_name || 'Sin título').trim();
  const authors = (work.authorships || [])
    .map((a) => a.author?.display_name || a.raw_author_name)
    .filter((n): n is string => Boolean(n))
    .slice(0, 10);

  const keywords = (work.keywords || [])
    .map((k) => k.display_name)
    .filter((k): k is string => Boolean(k))
    .slice(0, 8);

  const abstract = reconstructAbstract(work.abstract_inverted_index);
  const publisher =
    work.primary_location?.source?.display_name ||
    work.primary_location?.source?.host_organization_name ||
    'SciELO Network';

  const { area, label, subarea } = classifyOecdArea({
    title,
    abstract,
    keywords,
    publisher,
    openAlexDomainId: work.primary_topic?.domain?.id ?? undefined,
    openAlexFieldName: work.primary_topic?.field?.display_name ?? work.primary_topic?.display_name ?? undefined
  });

  const col = inferCollection(pdfUrl, scieloUrl, work.primary_location?.source?.display_name);
  const country = inferCountry({
    countryCode: work.primary_location?.source?.country_code,
    collectionCode: col.code,
    collection: col.collection,
    scieloUrl,
    pdfUrl,
    publisher
  });

  return {
    id: bookId ? `scielo-book-${bookId}` : `oa-${work.id.split('/').pop()}`,
    oaiIdentifier: bookId ?? work.id,
    title,
    authors,
    publisher,
    country,
    collection: col.collection,
    collectionCode: col.code,
    year: work.publication_year ?? null,
    publicationDate: work.publication_date ?? undefined,
    language: normalizeLanguage(work.language),
    docType: normalizeDocType(work.type),
    oecdArea: area,
    oecdAreaLabel: label,
    oecdSubarea: subarea,
    abstract:
      abstract ||
      (work.primary_topic?.display_name
        ? `Publicación indexada en SciELO sobre ${work.primary_topic.display_name}.`
        : 'Publicación científica de Acceso Abierto indexada en la red SciELO.'),
    keywords: keywords.length > 0 ? keywords : work.primary_topic?.display_name ? [work.primary_topic.display_name] : [],
    doi: work.doi ? work.doi.replace(/^https?:\/\/doi\.org\//i, '') : undefined,
    scieloUrl,
    pdfUrl,
    coverUrl,
    citedByCount: work.cited_by_count ?? 0,
    sourceOrigin: 'openalex'
  };
}

type CrossrefItem = {
  DOI?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string }>;
  publisher?: string;
  published?: { 'date-parts'?: number[][] };
  type?: string;
  URL?: string;
  ISBN?: string[];
  language?: string;
};

const SEARCH_TYPES = new Set(['all', 'book', 'chapter', 'article']);
const SEARCH_LANGS = new Set(['es', 'pt', 'en']);

async function fetchOpenAlex(url: string, userAgent: string): Promise<OpenAlexWork[]> {
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } }, 8_000);
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: OpenAlexWork[] };
    return Array.isArray(data.results) ? data.results : [];
  } catch {
    return [];
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = cleanText(url.searchParams.get('q'), MAX_QUERY_LENGTH);
  const typeParam = url.searchParams.get('type') || 'all';
  const type = SEARCH_TYPES.has(typeParam) ? typeParam : 'all';
  const langParam = url.searchParams.get('lang') || '';
  const lang = SEARCH_LANGS.has(langParam) ? langParam : '';
  const page = clampInt(url.searchParams.get('page'), 1, 1, 20);
  const perPage = clampInt(url.searchParams.get('perPage'), 12, 5, 25);

  if (q.length < 2) {
    return json({ query: q, page, count: 0, items: [] });
  }

  // Identical searches within 10 min are served from the edge (fewer D1 reads, fewer
  // OpenAlex/Crossref calls, no repeated write-backs).
  const cacheKey = cacheKeyFor(request, 'search-v1');
  try {
    const hit = await (await caches.open('coleebri-api-v1')).match(cacheKey);
    if (hit) return json(await hit.json(), 200, { 'Cache-Control': 'public, max-age=120', 'X-Edge-Cache': 'HIT' });
  } catch {
    // cache unavailable — continue
  }

  const results: Publication[] = [];
  const seenKeys = new Set<string>();
  const remember = (pub: Publication) => {
    const key = (pub.doi || pub.title).toLowerCase();
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    results.push(pub);
    return true;
  };

  // 1. Local D1 catalogue first (literal match, wildcards escaped, bounded pattern length)
  if (env.DB) {
    try {
      const order = "ORDER BY (pdf_url IS NOT NULL AND pdf_url != '') DESC, cited_by_count DESC, publication_year DESC LIMIT 20";
      const match = ftsMatchQuery(q);
      let rows: PublicationRow[] = [];
      try {
        if (match) {
          rows = (
            await env.DB.prepare(
              `SELECT * FROM publications WHERE rowid IN (SELECT rowid FROM publications_fts WHERE publications_fts MATCH ?) ${order}`
            )
              .bind(match)
              .all<PublicationRow>()
          ).results || [];
        }
      } catch (err) {
        if (!isMissingFtsError(err)) throw err;
        const words = searchWords(q);
        if (words.length > 0) {
          rows = (
            await env.DB.prepare(`SELECT * FROM publications WHERE ${words.map(() => SEARCH_WORD_CLAUSE).join(' AND ')} ${order}`)
              .bind(...words.flatMap(searchWordParams))
              .all<PublicationRow>()
          ).results || [];
        }
      }
      for (const row of rows) remember(rowToPublication(row));
    } catch (err) {
      console.error('[search] d1 lookup failed', err instanceof Error ? err.message : err);
    }
  }

  // 2. Federated OpenAlex query restricted to SciELO Books (10.7476) & SciELO journals
  const userAgent = politeUserAgent(env.CONTACT_EMAIL);
  const langFilter = lang ? `,language:${lang}` : '';
  const searchParam = `&search=${encodeURIComponent(q)}`;
  const queries: Promise<OpenAlexWork[]>[] = [];

  if (type === 'all' || type === 'book' || type === 'chapter') {
    const typeFilter = type === 'book' ? ',type:book' : type === 'chapter' ? ',type:book-chapter' : '';
    queries.push(
      fetchOpenAlex(
        `https://api.openalex.org/works?filter=doi_starts_with:10.7476,has_pdf_url:true${typeFilter}${langFilter}${searchParam}&per-page=${perPage}&page=${page}`,
        userAgent
      )
    );
  }
  if (type === 'all' || type === 'article') {
    queries.push(
      fetchOpenAlex(
        `https://api.openalex.org/works?filter=primary_location.source.listed_in:scielo,has_pdf_url:true${langFilter}${searchParam}&per-page=${Math.ceil(perPage / (type === 'all' ? 2 : 1))}&page=${page}`,
        userAgent
      )
    );
  }

  const fresh: Publication[] = [];
  for (const batch of await Promise.all(queries)) {
    for (const work of batch) {
      try {
        const mapped = sanitizePublication(mapOpenAlexWork(work));
        if (mapped && remember(mapped)) fresh.push(mapped);
      } catch {
        // skip malformed upstream record
      }
    }
  }

  // 3. Crossref (10.7476) fallback when OpenAlex is rate limited or returns little
  if (results.length < 3) {
    try {
      const crRes = await fetchWithTimeout(
        `https://api.crossref.org/prefixes/10.7476/works?query=${encodeURIComponent(q)}&rows=10`,
        { headers: { 'User-Agent': userAgent, Accept: 'application/json' } },
        8_000
      );
      if (crRes.ok) {
        const crData = (await crRes.json()) as { message?: { items?: CrossrefItem[] } };
        for (const item of crData.message?.items || []) {
          const title = item.title?.[0];
          if (!title || !item.DOI) continue;
          const publisher = item.publisher || 'SciELO Books';
          const { area, label, subarea } = classifyOecdArea({ title, publisher });
          const isbn = item.ISBN?.[0];
          const candidate = sanitizePublication({
            id: `cr-${item.DOI.replace(/[^a-zA-Z0-9]/g, '')}`,
            oaiIdentifier: item.DOI,
            title,
            authors: (item.author || []).map((a) => [a.family, a.given].filter(Boolean).join(', ')).filter(Boolean),
            publisher,
            isbn,
            country: inferCountry({ publisher, isbn }),
            collection: 'SciELO Books',
            collectionCode: 'books',
            year: item.published?.['date-parts']?.[0]?.[0] ?? null,
            language: (item.language as LanguageCode) || 'other',
            docType: item.type === 'book-chapter' ? 'chapter' : 'book',
            oecdArea: area,
            oecdAreaLabel: label,
            oecdSubarea: subarea,
            abstract: `Obra registrada en SciELO Books (${publisher}).`,
            keywords: [],
            doi: item.DOI,
            scieloUrl: `https://doi.org/${item.DOI}`,
            citedByCount: 0,
            sourceOrigin: 'openalex'
          });
          if (candidate && remember(candidate)) fresh.push(candidate);
        }
      }
    } catch {
      // ignore secondary fallback failure
    }
  }

  // 4. Lazy server-side cache: only records the SERVER fetched (never client-supplied data),
  //    only works with readable full text, INSERT-ONLY (never overwrites existing rows), and
  //    skipped for cross-site requests (e.g. <img src="/api/search?q=..."> on another site).
  const fetchSite = request.headers.get('sec-fetch-site');
  const sameSite = !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
  const persistable = fresh.filter((p) => p.pdfUrl).slice(0, 10);
  if (env.DB && sameSite && persistable.length > 0) {
    const stmt = env.DB.prepare(INSERT_NEW_PUBLICATION_SQL);
    context.waitUntil(
      env.DB.batch(persistable.map((p) => bindPublication(stmt, p))).catch((err) => {
        console.error('[search] persist failed', err instanceof Error ? err.message : err);
      })
    );
  }

  const body = { query: q, page, count: results.length, items: results, sources: { d1: Boolean(env.DB), openAlex: true } };
  context.waitUntil(
    caches
      .open('coleebri-api-v1')
      .then((cache) =>
        cache.put(
          cacheKey,
          new Response(JSON.stringify(body), {
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600' }
          })
        )
      )
      .catch(() => undefined)
  );
  return json(body, 200, { 'Cache-Control': 'public, max-age=120' });
};
