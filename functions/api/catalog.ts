import { rowToPublication, type Env, type PublicationRow } from '../types';
import { OECD_AREA_MAP } from '../../src/lib/taxonomy';
import type { Publication } from '../../src/types/publication';
import { UPSERT_PUBLICATION_SQL, bindPublication, sanitizePublication } from '../publications';
import {
  MAX_QUERY_LENGTH,
  clampInt,
  cleanText,
  errorResponse,
  SEARCH_WORD_CLAUSE,
  searchWordParams,
  searchWords,
  isAdminRequest,
  json,
  parseListParam,
  readJsonBody
} from '../security';

const SORTS: Record<string, string> = {
  'year-desc': 'publication_year DESC, cited_by_count DESC, title ASC',
  'year-asc': 'publication_year ASC, title ASC',
  citations: 'cited_by_count DESC, publication_year DESC',
  title: 'title COLLATE NOCASE ASC',
  relevance: "(pdf_url IS NOT NULL AND pdf_url != '') DESC, cited_by_count DESC, publication_year DESC"
};

const LANGS = new Set(['es', 'pt', 'en', 'other']);
const TYPES = new Set(['book', 'chapter', 'article']);
const AREAS = new Set(Object.keys(OECD_AREA_MAP));

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) {
    return json({
      source: 'fallback',
      items: [],
      total: 0,
      message: 'Base de datos no disponible; se usa el catálogo local.'
    });
  }

  const url = new URL(request.url);
  const q = cleanText(url.searchParams.get('q'), MAX_QUERY_LENGTH);
  const areas = parseListParam(url.searchParams.get('areas'), AREAS);
  const langs = parseListParam(url.searchParams.get('langs'), LANGS);
  const countries = parseListParam(url.searchParams.get('countries'));
  const types = parseListParam(url.searchParams.get('types'), TYPES);
  const collections = parseListParam(url.searchParams.get('collections'));
  const yearFrom = clampInt(url.searchParams.get('yearFrom'), Number.NaN, 1500, 2100);
  const yearTo = clampInt(url.searchParams.get('yearTo'), Number.NaN, 1500, 2100);
  const onlyPdf = url.searchParams.get('onlyPdf') === '1';
  const orderBy = SORTS[url.searchParams.get('sort') || 'year-desc'] ?? SORTS['year-desc'];
  const limit = clampInt(url.searchParams.get('limit'), 60, 1, 120);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
  const withFacets = url.searchParams.get('facets') !== '0';

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (q) {
    // Each word must appear somewhere (AND), accent/case-insensitive via the folded
    // `search_text` column. D1 limits: LIKE pattern <= 50 bytes, ~100 bound params.
    for (const word of searchWords(q)) {
      conditions.push(SEARCH_WORD_CLAUSE);
      params.push(...searchWordParams(word));
    }
  }
  const inList = (column: string, values: string[]) => {
    if (values.length === 0) return;
    conditions.push(`${column} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };
  inList('oecd_area', areas);
  inList('language', langs);
  inList('country', countries);
  inList('doc_type', types);
  inList('collection_code', collections);
  if (!Number.isNaN(yearFrom)) {
    conditions.push('publication_year >= ?');
    params.push(yearFrom);
  }
  if (!Number.isNaN(yearTo)) {
    conditions.push('publication_year <= ?');
    params.push(yearTo);
  }
  if (onlyPdf) conditions.push("pdf_url IS NOT NULL AND pdf_url != ''");

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const listPromise = env.DB.prepare(`SELECT * FROM publications ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<PublicationRow>();
    const countPromise = env.DB.prepare(`SELECT COUNT(*) as cnt FROM publications ${where}`)
      .bind(...params)
      .first<{ cnt: number }>();

    const facetPromise = withFacets
      ? env.DB.batch([
          env.DB.prepare('SELECT oecd_area as value, COUNT(*) as count FROM publications GROUP BY oecd_area'),
          env.DB.prepare('SELECT language as value, COUNT(*) as count FROM publications GROUP BY language'),
          env.DB.prepare('SELECT country as value, COUNT(*) as count FROM publications GROUP BY country ORDER BY count DESC'),
          env.DB.prepare('SELECT doc_type as value, COUNT(*) as count FROM publications GROUP BY doc_type'),
          env.DB.prepare('SELECT collection_code as value, MAX(collection) as label, COUNT(*) as count FROM publications GROUP BY collection_code'),
          env.DB.prepare("SELECT COUNT(*) as count FROM publications WHERE pdf_url IS NOT NULL AND pdf_url != ''"),
          env.DB.prepare('SELECT COUNT(*) as count FROM publications')
        ])
      : Promise.resolve(null);

    const [listRes, countRes, facets] = await Promise.all([listPromise, countPromise, facetPromise]);
    const items = (listRes.results || []).map(rowToPublication);

    return json(
      {
        source: 'd1',
        items,
        total: countRes?.cnt ?? items.length,
        offset,
        limit,
        hasMore: offset + items.length < (countRes?.cnt ?? 0),
        facets: facets
          ? {
              oecdAreas: facets[0].results || [],
              languages: facets[1].results || [],
              countries: facets[2].results || [],
              docTypes: facets[3].results || [],
              collections: facets[4].results || [],
              withPdf: (facets[5].results?.[0] as { count?: number } | undefined)?.count ?? 0,
              catalogSize: (facets[6].results?.[0] as { count?: number } | undefined)?.count ?? 0
            }
          : undefined
      },
      200,
      { 'Cache-Control': 'public, max-age=60' }
    );
  } catch (err) {
    console.error('[catalog] query failed', err instanceof Error ? err.message : err);
    return errorResponse(500, 'catalog_query_failed', 'No se pudo consultar el catálogo.');
  }
};

/** Catalog writes are ADMIN ONLY (Authorization: Bearer <ADMIN_TOKEN>). Anonymous visitors get 404. */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!(await isAdminRequest(request, env.ADMIN_TOKEN))) {
    return errorResponse(404, 'not_found');
  }
  if (!env.DB) return errorResponse(503, 'database_unavailable');

  const body = await readJsonBody<{ publications?: Partial<Publication>[] }>(request, 2 * 1024 * 1024);
  const pubs = (Array.isArray(body.publications) ? body.publications.slice(0, 200) : [])
    .map(sanitizePublication)
    .filter((p): p is Publication => p !== null);
  if (pubs.length === 0) return json({ inserted: 0 });

  const stmt = env.DB.prepare(UPSERT_PUBLICATION_SQL);
  await env.DB.batch(pubs.map((p) => bindPublication(stmt, p)));
  return json({ inserted: pubs.length });
};
