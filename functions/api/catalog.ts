import { rowToPublication, type Env, type PublicationRow } from '../types';
import { OECD_AREA_MAP } from '../../src/lib/taxonomy';
import type { Publication } from '../../src/types/publication';
import { UPSERT_PUBLICATION_SQL, bindPublication, sanitizePublication } from '../publications';
import { cacheKeyFor, cachedJson } from '../cache';
import {
  MAX_QUERY_LENGTH,
  clampInt,
  cleanText,
  errorResponse,
  SEARCH_WORD_CLAUSE,
  ftsMatchQuery,
  isMissingFtsError,
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

type FacetValue = { value: string; label?: string; count: number };
interface CatalogFacets {
  oecdAreas: FacetValue[];
  languages: FacetValue[];
  countries: FacetValue[];
  docTypes: FacetValue[];
  collections: FacetValue[];
  withPdf: number;
  catalogSize: number;
}

/** Global facet counts are the same for every visitor: computed at most once per hour per colo. */
async function loadFacets(db: D1Database): Promise<CatalogFacets> {
  const res = await db.batch([
    db.prepare('SELECT oecd_area as value, COUNT(*) as count FROM publications GROUP BY oecd_area'),
    db.prepare('SELECT language as value, COUNT(*) as count FROM publications GROUP BY language'),
    db.prepare('SELECT country as value, COUNT(*) as count FROM publications GROUP BY country ORDER BY count DESC'),
    db.prepare('SELECT doc_type as value, COUNT(*) as count FROM publications GROUP BY doc_type'),
    db.prepare(
      'SELECT collection_code as value, MAX(collection) as label, COUNT(*) as count FROM publications GROUP BY collection_code ORDER BY count DESC'
    ),
    db.prepare("SELECT COUNT(*) as count FROM publications WHERE pdf_url IS NOT NULL AND pdf_url != ''"),
    db.prepare('SELECT COUNT(*) as count FROM publications')
  ]);
  const rows = (i: number) => (res[i].results || []) as FacetValue[];
  return {
    oecdAreas: rows(0),
    languages: rows(1),
    countries: rows(2),
    docTypes: rows(3),
    collections: rows(4),
    withPdf: (res[5].results?.[0] as { count?: number } | undefined)?.count ?? 0,
    catalogSize: (res[6].results?.[0] as { count?: number } | undefined)?.count ?? 0
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  if (!env.DB) {
    return json({
      source: 'fallback',
      items: [],
      total: 0,
      message: 'Base de datos no disponible; se usa el catálogo local.'
    });
  }
  const db = env.DB;

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

  /** Builds WHERE + params; `useFts` picks the FTS5 index or the LIKE fallback. */
  const buildWhere = (useFts: boolean) => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (q) {
      if (useFts) {
        const match = ftsMatchQuery(q);
        if (match) {
          conditions.push('rowid IN (SELECT rowid FROM publications_fts WHERE publications_fts MATCH ?)');
          params.push(match);
        }
      } else {
        // Fallback while migration 0006 is pending: folded LIKE (bounded patterns/params).
        for (const word of searchWords(q)) {
          conditions.push(SEARCH_WORD_CLAUSE);
          params.push(...searchWordParams(word));
        }
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
    return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
  };

  const runQuery = async (useFts: boolean) => {
    const { where, params } = buildWhere(useFts);
    const [listRes, countRes] = await db.batch([
      db.prepare(`SELECT * FROM publications ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).bind(...params, limit, offset),
      db.prepare(`SELECT COUNT(*) as cnt FROM publications ${where}`).bind(...params)
    ]);
    const total = ((countRes.results?.[0] as { cnt?: number } | undefined)?.cnt ?? 0) as number;
    const items = ((listRes.results || []) as unknown as PublicationRow[]).map(rowToPublication);
    return { items, total };
  };

  try {
    // Whole page cached 5 min per colo (same filters → same answer for every visitor).
    const { data: page } = await cachedJson(context, cacheKeyFor(request, 'catalog-v1', ['facets']), 300, async () => {
      try {
        return await runQuery(true);
      } catch (err) {
        if (!isMissingFtsError(err)) throw err;
        return runQuery(false);
      }
    });
    const facets = withFacets
      ? (await cachedJson(context, cacheKeyFor(new Request(`${url.origin}/`), 'facets-v1'), 3600, () => loadFacets(db))).data
      : undefined;

    return json(
      {
        source: 'd1',
        items: page.items,
        total: page.total,
        offset,
        limit,
        hasMore: offset + page.items.length < page.total,
        facets
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
