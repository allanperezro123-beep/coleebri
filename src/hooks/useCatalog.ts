import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CatalogFilters,
  CatalogStats,
  DocumentType,
  FacetBucket,
  LanguageCode,
  Publication
} from '../types/publication';
import { DOCTYPE_LABELS, LANGUAGE_LABELS, normalizePublication, normalizePublications } from '../lib/publication';
import { fold, foldedTitleOf, haystackOf, matchesTokens, queryTokens } from '../lib/search';
import { loadSeedCatalog } from '../lib/seed';
import { OECD_AREAS } from '../lib/taxonomy';

export interface AutocompleteSuggestion {
  value: string;
  label: string;
  category: 'título' | 'autor' | 'tema' | 'doi' | 'editorial';
}

export type FacetKey = 'oecdAreas' | 'languages' | 'countries' | 'docTypes' | 'collections';

export const PAGE_SIZE = 60;
const DEBOUNCE_MS = 250;
const LANGUAGE_ORDER: LanguageCode[] = ['es', 'pt', 'en', 'other'];
const DOCTYPE_ORDER: DocumentType[] = ['book', 'chapter', 'article'];

export const DEFAULT_FILTERS: CatalogFilters = {
  query: '',
  oecdAreas: [],
  languages: [],
  countries: [],
  docTypes: [],
  collections: [],
  yearFrom: null,
  yearTo: null,
  onlyWithPdf: true,
  sortBy: 'year-desc'
};

type Mode = 'pending' | 'server' | 'seed';

interface ServerFacets {
  oecdAreas: FacetBucket[];
  languages: FacetBucket[];
  countries: FacetBucket[];
  docTypes: FacetBucket[];
  collections: FacetBucket[];
  withPdf: number;
  catalogSize: number;
}

interface ServerPage {
  items: Publication[];
  rawCount: number;
  offset: number;
  total: number;
  hasMore: boolean;
  facets: ServerFacets | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBuckets(raw: unknown): FacetBucket[] {
  if (!Array.isArray(raw)) return [];
  const out: FacetBucket[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.value !== 'string' || !entry.value) continue;
    const count = typeof entry.count === 'number' && Number.isFinite(entry.count) ? entry.count : 0;
    const label = typeof entry.label === 'string' && entry.label ? entry.label : entry.value;
    out.push({ value: entry.value, label, count });
  }
  return out;
}

function parseFacets(raw: unknown): ServerFacets | null {
  if (!isRecord(raw)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    oecdAreas: parseBuckets(raw.oecdAreas),
    languages: parseBuckets(raw.languages),
    countries: parseBuckets(raw.countries),
    docTypes: parseBuckets(raw.docTypes),
    collections: parseBuckets(raw.collections),
    withPdf: num(raw.withPdf),
    catalogSize: num(raw.catalogSize)
  };
}

/** Returns null when the response is not a usable database answer (fallback, HTML, malformed). */
function parseCatalogResponse(data: unknown): ServerPage | null {
  if (!isRecord(data) || data.source !== 'd1' || !Array.isArray(data.items)) return null;
  const items = normalizePublications(data.items);
  const offset = typeof data.offset === 'number' ? data.offset : 0;
  const total = typeof data.total === 'number' && Number.isFinite(data.total) ? data.total : items.length;
  return {
    items,
    rawCount: data.items.length,
    offset,
    total,
    hasMore: data.hasMore === true,
    facets: parseFacets(data.facets)
  };
}

function buildCatalogParams(f: CatalogFilters, offset: number, withFacets: boolean): URLSearchParams {
  const params = new URLSearchParams();
  const q = f.query.trim().slice(0, 200);
  if (q) params.set('q', q);
  const list = (key: string, values: string[]) => {
    if (values.length > 0) params.set(key, values.slice(0, 10).join(','));
  };
  list('areas', f.oecdAreas);
  list('langs', f.languages);
  list('countries', f.countries);
  list('types', f.docTypes);
  list('collections', f.collections);
  if (f.yearFrom !== null) params.set('yearFrom', String(f.yearFrom));
  if (f.yearTo !== null) params.set('yearTo', String(f.yearTo));
  if (f.onlyWithPdf) params.set('onlyPdf', '1');
  params.set('sort', f.sortBy);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  if (!withFacets) params.set('facets', '0');
  return params;
}

async function fetchCatalogPage(
  filters: CatalogFilters,
  offset: number,
  withFacets: boolean,
  signal: AbortSignal
): Promise<ServerPage | null> {
  const res = await fetch('/api/catalog?' + buildCatalogParams(filters, offset, withFacets).toString(), {
    signal,
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return null; // e.g. plain `vite` answers /api/* with index.html
  }
  return parseCatalogResponse(data);
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (value === '') {
      setDebounced(value);
      return;
    }
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function sortSeed(list: Publication[], filters: CatalogFilters, tokens: string[]): Publication[] {
  const out = list.slice();
  const { sortBy } = filters;
  out.sort((a, b) => {
    if (sortBy === 'year-desc') return (b.year ?? 0) - (a.year ?? 0) || (b.citedByCount ?? 0) - (a.citedByCount ?? 0);
    if (sortBy === 'year-asc') return (a.year ?? 9999) - (b.year ?? 9999);
    if (sortBy === 'citations') return (b.citedByCount ?? 0) - (a.citedByCount ?? 0) || (b.year ?? 0) - (a.year ?? 0);
    if (sortBy === 'title') return a.title.localeCompare(b.title, 'es');
    // relevance: title hits first, then readable works, then citations / recency
    if (tokens.length > 0) {
      const aTitle = matchesTokens(foldedTitleOf(a), tokens) ? 1 : 0;
      const bTitle = matchesTokens(foldedTitleOf(b), tokens) ? 1 : 0;
      if (aTitle !== bTitle) return bTitle - aTitle;
    }
    return (
      (b.pdfUrl ? 1 : 0) - (a.pdfUrl ? 1 : 0) ||
      (b.citedByCount ?? 0) - (a.citedByCount ?? 0) ||
      (b.year ?? 0) - (a.year ?? 0)
    );
  });
  return out;
}

function filterSeed(all: Publication[], f: CatalogFilters): Publication[] {
  const tokens = queryTokens(f.query);
  const areaSet = new Set<string>(f.oecdAreas);
  const langSet = new Set<string>(f.languages);
  const countrySet = new Set(f.countries);
  const typeSet = new Set<string>(f.docTypes);
  const colSet = new Set(f.collections);

  const matched = all.filter((p) => {
    if (f.onlyWithPdf && !p.pdfUrl) return false;
    if (areaSet.size > 0 && !areaSet.has(p.oecdArea)) return false;
    if (langSet.size > 0 && !langSet.has(p.language)) return false;
    if (countrySet.size > 0 && !countrySet.has(p.country || 'Internacional')) return false;
    if (typeSet.size > 0 && !typeSet.has(p.docType)) return false;
    if (colSet.size > 0 && !colSet.has(p.collectionCode)) return false;
    if (f.yearFrom !== null && (p.year === null || p.year < f.yearFrom)) return false;
    if (f.yearTo !== null && (p.year === null || p.year > f.yearTo)) return false;
    return tokens.length === 0 || matchesTokens(haystackOf(p), tokens);
  });
  return sortSeed(matched, f, tokens);
}

function statsFromSeed(items: Publication[]): CatalogStats {
  const areaCounts = new Map<string, number>();
  const langCounts = new Map<string, number>();
  const countryCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const colCounts = new Map<string, { label: string; count: number }>();
  let yearMin = 9999;
  let yearMax = 0;
  let withPdf = 0;

  for (const p of items) {
    if (p.pdfUrl) withPdf++;
    areaCounts.set(p.oecdArea, (areaCounts.get(p.oecdArea) ?? 0) + 1);
    langCounts.set(p.language, (langCounts.get(p.language) ?? 0) + 1);
    const country = p.country || 'Internacional';
    countryCounts.set(country, (countryCounts.get(country) ?? 0) + 1);
    typeCounts.set(p.docType, (typeCounts.get(p.docType) ?? 0) + 1);
    const col = colCounts.get(p.collectionCode);
    colCounts.set(p.collectionCode, { label: p.collection, count: (col?.count ?? 0) + 1 });
    if (p.year && p.year >= 1900 && p.year <= 2100) {
      yearMin = Math.min(yearMin, p.year);
      yearMax = Math.max(yearMax, p.year);
    }
  }

  return {
    total: items.length,
    withPdf,
    oecdAreas: OECD_AREAS.map((a) => ({ value: a.id, label: a.label, count: areaCounts.get(a.id) ?? 0 })),
    languages: LANGUAGE_ORDER.map((code) => ({
      value: code,
      label: LANGUAGE_LABELS[code],
      count: langCounts.get(code) ?? 0
    })).filter((b) => b.count > 0),
    countries: [...countryCounts.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => b.count - a.count),
    docTypes: DOCTYPE_ORDER.map((type) => ({
      value: type,
      label: DOCTYPE_LABELS[type],
      count: typeCounts.get(type) ?? 0
    })).filter((b) => b.count > 0),
    collections: [...colCounts.entries()]
      .map(([value, info]) => ({ value, label: info.label, count: info.count }))
      .sort((a, b) => b.count - a.count),
    yearMin: yearMax >= yearMin ? yearMin : 1990,
    yearMax: yearMax >= yearMin ? yearMax : new Date().getFullYear()
  };
}

function statsFromFacets(facets: ServerFacets | null): CatalogStats {
  const year = new Date().getFullYear();
  if (!facets) {
    return {
      total: 0,
      withPdf: 0,
      oecdAreas: OECD_AREAS.map((a) => ({ value: a.id, label: a.label, count: 0 })),
      languages: [],
      countries: [],
      docTypes: [],
      collections: [],
      yearMin: 1990,
      yearMax: year
    };
  }
  const byValue = (buckets: FacetBucket[]) => new Map(buckets.map((b) => [b.value, b.count]));
  const areas = byValue(facets.oecdAreas);
  const langs = byValue(facets.languages);
  const types = byValue(facets.docTypes);
  return {
    total: facets.catalogSize,
    withPdf: facets.withPdf,
    oecdAreas: OECD_AREAS.map((a) => ({ value: a.id, label: a.label, count: areas.get(a.id) ?? 0 })),
    languages: LANGUAGE_ORDER.map((code) => ({
      value: code,
      label: LANGUAGE_LABELS[code],
      count: langs.get(code) ?? 0
    })).filter((b) => b.count > 0),
    countries: facets.countries
      .map((b) => ({ value: b.value, label: b.value, count: b.count }))
      .sort((a, b) => b.count - a.count),
    docTypes: DOCTYPE_ORDER.map((type) => ({
      value: type,
      label: DOCTYPE_LABELS[type],
      count: types.get(type) ?? 0
    })).filter((b) => b.count > 0),
    collections: [...facets.collections].sort((a, b) => b.count - a.count),
    yearMin: 1990,
    yearMax: year
  };
}

function liveKey(p: Publication): string {
  return (p.doi || p.id).toLowerCase();
}

export function useCatalog() {
  const [filters, setFilters] = useState<CatalogFilters>(DEFAULT_FILTERS);
  const debouncedQuery = useDebounced(filters.query, DEBOUNCE_MS);

  const [mode, setModeState] = useState<Mode>('pending');
  const modeRef = useRef<Mode>('pending');
  const setMode = useCallback((next: Mode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);

  // server-driven data
  const [serverItems, setServerItems] = useState<Publication[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [serverHasMore, setServerHasMore] = useState(false);
  const [facets, setFacets] = useState<ServerFacets | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // seed-driven data (only when the server is unavailable)
  const [seedAll, setSeedAll] = useState<Publication[] | null>(null);
  const [seedVisible, setSeedVisible] = useState(PAGE_SIZE);

  // live (SciELO online) search results: kept apart from the paginated catalogue
  const [liveItems, setLiveItems] = useState<Publication[]>([]);
  const [liveQuery, setLiveQuery] = useState('');
  const [liveSearching, setLiveSearching] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const liveAbortRef = useRef<AbortController | null>(null);

  const [reloadTick, setReloadTick] = useState(0);
  const forceRef = useRef(false);
  const loadedKeyRef = useRef<string | null>(null);
  const loadedFiltersRef = useRef<CatalogFilters>(DEFAULT_FILTERS);
  const nextOffsetRef = useRef(0);
  const hasMoreRef = useRef(false);
  const inFlightRef = useRef(false);
  const moreAbortRef = useRef<AbortController | null>(null);

  const effective = useMemo<CatalogFilters>(() => ({ ...filters, query: debouncedQuery }), [filters, debouncedQuery]);
  const queryKey = useMemo(() => JSON.stringify(effective), [effective]);

  // ---- load page 0 whenever the effective filters change (and probe the server on first run) ----
  useEffect(() => {
    if (modeRef.current === 'seed' && !forceRef.current) return;
    if (modeRef.current === 'server' && loadedKeyRef.current === queryKey && !forceRef.current) {
      // Filters went back to what is already loaded (e.g. a facet toggled on then off while the
      // first request was in flight and got aborted): make sure the busy state is cleared.
      setRefreshing(false);
      return;
    }
    const probing = modeRef.current !== 'server' || forceRef.current;
    forceRef.current = false;

    moreAbortRef.current?.abort();
    inFlightRef.current = false;
    setLoadingMore(false);
    setLoadMoreError(false);

    const controller = new AbortController();
    setRefreshing(true);
    setErrorMessage(null);

    const fallbackToSeed = async () => {
      const seed = await loadSeedCatalog();
      if (controller.signal.aborted) return;
      loadedKeyRef.current = queryKey;
      setSeedAll(seed);
      setMode('seed');
      setRefreshing(false);
    };

    void (async () => {
      try {
        const page = await fetchCatalogPage(effective, 0, probing || facets === null, controller.signal);
        if (controller.signal.aborted) return;
        const emptyDatabase = page !== null && page.facets !== null && page.facets.catalogSize === 0;
        if (!page || emptyDatabase) {
          if (modeRef.current === 'server') {
            setErrorMessage('No pudimos actualizar los resultados. Inténtalo de nuevo en un momento.');
            setRefreshing(false);
            return;
          }
          await fallbackToSeed();
          return;
        }
        loadedKeyRef.current = queryKey;
        loadedFiltersRef.current = effective;
        nextOffsetRef.current = page.offset + page.rawCount;
        hasMoreRef.current = page.hasMore;
        setServerItems(page.items);
        setServerTotal(page.total);
        setServerHasMore(page.hasMore);
        if (page.facets) setFacets(page.facets);
        setMode('server');
        setRefreshing(false);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        if (modeRef.current === 'server') {
          setErrorMessage('No pudimos actualizar los resultados. Revisa tu conexión e inténtalo de nuevo.');
          setRefreshing(false);
          return;
        }
        try {
          await fallbackToSeed();
        } catch {
          if (controller.signal.aborted) return;
          setErrorMessage('No pudimos cargar el catálogo. Revisa tu conexión e inténtalo de nuevo.');
          setMode('seed');
          setSeedAll([]);
          setRefreshing(false);
        }
      }
    })();

    return () => controller.abort();
    // `facets` is read only to decide whether facet counts are still missing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, reloadTick]);

  // seed mode: show the first page again when the filters change
  useEffect(() => {
    setSeedVisible(PAGE_SIZE);
  }, [queryKey]);

  const loadMore = useCallback(async () => {
    if (inFlightRef.current) return;
    if (modeRef.current === 'seed') {
      setSeedVisible((visible) => visible + PAGE_SIZE);
      return;
    }
    if (modeRef.current !== 'server' || !hasMoreRef.current) return;

    inFlightRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(false);
    const controller = new AbortController();
    moreAbortRef.current = controller;
    const keyAtStart = loadedKeyRef.current;

    try {
      const page = await fetchCatalogPage(loadedFiltersRef.current, nextOffsetRef.current, false, controller.signal);
      if (controller.signal.aborted || loadedKeyRef.current !== keyAtStart) return;
      if (!page) throw new Error('bad response');
      nextOffsetRef.current = page.offset + page.rawCount;
      hasMoreRef.current = page.hasMore && page.rawCount > 0;
      setServerHasMore(hasMoreRef.current);
      setServerTotal(page.total);
      setServerItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const merged = prev.slice();
        for (const item of page.items) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            merged.push(item);
          }
        }
        return merged;
      });
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
        setLoadMoreError(true);
      }
    } finally {
      if (!controller.signal.aborted) {
        inFlightRef.current = false;
        setLoadingMore(false);
      }
    }
  }, []);

  const reload = useCallback(() => {
    forceRef.current = true;
    loadedKeyRef.current = null;
    setReloadTick((tick) => tick + 1);
  }, []);

  // ---- derived list ----
  const seedFiltered = useMemo(() => (seedAll ? filterSeed(seedAll, effective) : []), [seedAll, effective]);
  const items = useMemo(
    () => (mode === 'seed' ? seedFiltered.slice(0, seedVisible) : serverItems),
    [mode, seedFiltered, seedVisible, serverItems]
  );
  const total = mode === 'seed' ? seedFiltered.length : serverTotal;
  const hasMore = mode === 'seed' ? seedVisible < seedFiltered.length : serverHasMore;

  const stats = useMemo<CatalogStats>(
    () => (mode === 'seed' ? statsFromSeed(seedAll ?? []) : statsFromFacets(facets)),
    [mode, seedAll, facets]
  );

  // everything we currently know about (for autocomplete and "continue reading" lookups)
  const knownPublications = mode === 'seed' ? (seedAll ?? []) : serverItems;

  const suggestionIndex = useMemo(() => {
    const unique = new Map<string, { suggestion: AutocompleteSuggestion; folded: string }>();
    const add = (raw: string | undefined, category: AutocompleteSuggestion['category']) => {
      const clean = raw?.trim();
      if (!clean || clean.length < 3) return;
      const folded = fold(clean);
      const key = category + ':' + folded;
      if (!unique.has(key)) unique.set(key, { suggestion: { value: clean, label: clean, category }, folded });
    };
    for (const pub of knownPublications) {
      add(pub.title, 'título');
      for (const author of pub.authors) add(author, 'autor');
      for (const kw of pub.keywords) add(kw, 'tema');
      add(pub.doi, 'doi');
      add(pub.publisher, 'editorial');
    }
    return [...unique.values()];
  }, [knownPublications]);

  const getSuggestions = useCallback(
    (rawInput: string): AutocompleteSuggestion[] => {
      const tokens = queryTokens(rawInput);
      if (rawInput.trim().length < 2 || tokens.length === 0) return [];
      const starts: AutocompleteSuggestion[] = [];
      const contains: AutocompleteSuggestion[] = [];
      const lead = tokens[0];
      for (const entry of suggestionIndex) {
        if (!matchesTokens(entry.folded, tokens)) continue;
        (entry.folded.startsWith(lead) ? starts : contains).push(entry.suggestion);
        if (starts.length >= 8) break;
      }
      return [...starts, ...contains].slice(0, 8);
    },
    [suggestionIndex]
  );

  // ---- live search (OpenAlex / Crossref through our own API) ----
  const searchLive = useCallback(async (rawQuery: string) => {
    const q = rawQuery.trim();
    if (q.length < 2) return;
    liveAbortRef.current?.abort();
    const controller = new AbortController();
    liveAbortRef.current = controller;
    setLiveSearching(true);
    setLiveError(null);
    try {
      const params = new URLSearchParams({ q: q.slice(0, 200), perPage: '16' });
      const res = await fetch('/api/search?' + params.toString(), { signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data: unknown = await res.json();
      if (!isRecord(data) || !Array.isArray(data.items)) throw new Error('bad response');
      const incoming: Publication[] = [];
      for (const raw of data.items) {
        const pub = normalizePublication(raw);
        if (pub) incoming.push(pub);
      }
      if (controller.signal.aborted) return;
      setLiveItems(incoming);
      setLiveQuery(q);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setLiveItems([]);
      setLiveQuery('');
      setLiveError('La búsqueda en SciELO no está disponible ahora. Seguimos mostrando el catálogo de Coleebri.');
    } finally {
      if (!controller.signal.aborted) setLiveSearching(false);
    }
  }, []);

  const clearLive = useCallback(() => {
    liveAbortRef.current?.abort();
    setLiveItems([]);
    setLiveQuery('');
    setLiveError(null);
    setLiveSearching(false);
  }, []);

  const visibleLiveItems = useMemo(() => {
    if (liveItems.length === 0 || fold(liveQuery) !== fold(debouncedQuery.trim())) return [];
    const known = new Set(items.map(liveKey));
    return liveItems.filter((p) => !known.has(liveKey(p)));
  }, [liveItems, liveQuery, debouncedQuery, items]);

  // ---- filter setters ----
  const updateFilters = useCallback((patch: Partial<CatalogFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const setQuery = useCallback((query: string) => setFilters((prev) => ({ ...prev, query })), []);

  const toggleFacet = useCallback(<K extends FacetKey>(key: K, value: CatalogFilters[K][number]) => {
    setFilters((prev) => {
      const current = prev[key] as string[];
      const next = current.includes(value as string)
        ? current.filter((v) => v !== value)
        : [...current, value as string];
      return { ...prev, [key]: next };
    });
  }, []);

  /** Replaces the whole selection of a facet (used by the single-select quick bar). */
  const setFacetValues = useCallback(<K extends FacetKey>(key: K, values: CatalogFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: values }));
  }, []);

  /** Clears everything, including the "full text only" default, so the visitor sees every work. */
  const resetFilters = useCallback(() => {
    setFilters((prev) => ({ ...DEFAULT_FILTERS, onlyWithPdf: false, sortBy: prev.sortBy }));
    clearLive();
  }, [clearLive]);

  const activeFilterCount =
    filters.oecdAreas.length +
    filters.languages.length +
    filters.countries.length +
    filters.docTypes.length +
    filters.collections.length +
    (filters.yearFrom !== null || filters.yearTo !== null ? 1 : 0);

  const loading = mode === 'pending' || (refreshing && items.length === 0);

  return {
    mode,
    items,
    total,
    hasMore,
    loading,
    refreshing: refreshing && items.length > 0,
    loadingMore,
    loadMoreError,
    errorMessage,
    stats,
    filters,
    effectiveQuery: debouncedQuery,
    activeFilterCount,
    knownPublications,
    liveItems: visibleLiveItems,
    liveSearching,
    liveError,
    getSuggestions,
    updateFilters,
    setQuery,
    toggleFacet,
    setFacetValues,
    resetFilters,
    searchLive,
    clearLive,
    loadMore,
    reload
  };
}
