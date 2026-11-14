import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { CatalogGrid } from './components/CatalogGrid';
import { ColeebriLogo } from './components/ColeebriLogo';
import { ContinueReading, type ContinueEntry } from './components/ContinueReading';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FacetSidebar } from './components/FacetSidebar';
import { Header } from './components/Header';
import { OfflineBanner } from './components/OfflineBanner';
import { QuickFilterBar } from './components/QuickFilterBar';
import { RecentShelf } from './components/RecentShelf';
import { useCatalog } from './hooks/useCatalog';
import { useReadingProgress } from './hooks/useReadingProgress';
import { useShelves } from './hooks/useShelves';
import { DOCTYPE_LABELS, LANGUAGE_LABELS, getArea, normalizePublications } from './lib/publication';
import { readJson, readString, writeJson, writeString } from './lib/storage';
import { sourceInfo } from './lib/sources';
import type { CatalogFilters, DocumentType, LanguageCode, Publication } from './types/publication';

// Heavy, rarely-needed surfaces are split out of the main bundle (P1).
const PdfReaderModal = lazy(() => import('./components/PdfReaderModal').then((m) => ({ default: m.PdfReaderModal })));
const PreviewDrawer = lazy(() => import('./components/PreviewDrawer').then((m) => ({ default: m.PreviewDrawer })));
const ShelvesModal = lazy(() => import('./components/ShelvesModal').then((m) => ({ default: m.ShelvesModal })));
const SyncStatusModal = lazy(() => import('./components/SyncStatusModal').then((m) => ({ default: m.SyncStatusModal })));

const THEME_KEY = 'coleebri:theme';
const VIEW_KEY = 'coleebri:view';
const RECENT_KEY = 'coleebri:recent:v1';
const MAX_RECENT = 24;
const TOPICS = ['Educación', 'Pedagogía', 'Colombia', 'Salud', 'Historia'];

interface ToastState {
  text: string;
  tone: 'ok' | 'warn';
}

function LoadingOverlay() {
  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center"
      style={{ backgroundColor: 'var(--scrim)' }}
      role="status"
    >
      <p className="callout" style={{ backgroundColor: 'var(--bg-elevated)' }}>
        Cargando…
      </p>
    </div>
  );
}

function initialViewMode(): 'grid' | 'list' {
  const stored = readString(VIEW_KEY);
  // Covers first on every screen size; the list is an explicit choice the visitor made.
  return stored === 'list' ? 'list' : 'grid';
}

/** Small snapshot kept so "Continuar leyendo" works even when the book is not in the current page of results. */
function slimPublication(pub: Publication): Publication {
  return { ...pub, abstract: pub.abstract.slice(0, 400), keywords: [] };
}

export function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => document.documentElement.classList.contains('dark'));
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(initialViewMode);
  const [showDesktopSidebar, setShowDesktopSidebar] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [selectedPublication, setSelectedPublication] = useState<Publication | null>(null);
  const [readerState, setReaderState] = useState<{ pub: Publication; initialPage: number } | null>(null);
  const [shelvesModalOpen, setShelvesModalOpen] = useState(false);
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [recentPubs, setRecentPubs] = useState<Publication[]>(() => normalizePublications(readJson(RECENT_KEY)));

  const catalog = useCatalog();
  const progressMap = useReadingProgress();
  const {
    shelves,
    shelfItems,
    syncedWithD1,
    notice: shelvesNotice,
    dismissNotice,
    savedPublicationIds,
    getPublicationShelves,
    createShelf,
    deleteShelf,
    toggleInShelf,
    updateNote,
    setReadingPage
  } = useShelves();

  const { updateFilters, setQuery, toggleFacet, setFacetValues, resetFilters, searchLive, clearLive } = catalog;

  // Latest values read by stable callbacks
  const progressRef = useRef(progressMap);
  progressRef.current = progressMap;
  const recentRef = useRef(recentPubs);
  const readerPubRef = useRef<Publication | null>(null);

  // ---- theme ----
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute('content', darkMode ? '#0E1116' : '#FAF9F6');
    });
  }, [darkMode]);

  const handleToggleDarkMode = () => {
    const next = !darkMode;
    setDarkMode(next);
    writeString(THEME_KEY, next ? 'dark' : 'light');
  };

  const handleViewModeChange = useCallback((mode: 'grid' | 'list') => {
    setViewMode(mode);
    writeString(VIEW_KEY, mode);
  }, []);

  // ---- "Recién llegados" illustrated shelf (SciELO Books WebP covers) ----
  const [shelfCovers, setShelfCovers] = useState<Publication[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/catalog?collections=books&onlyPdf=1&sort=year-desc&limit=14&facets=0', {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { items?: Publication[] } | null) => {
        if (!data || !Array.isArray(data.items)) return;
        setShelfCovers(data.items.filter((p): p is Publication => Boolean(p?.id && p.coverUrl)));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // ---- toast (auto-dismiss) ----
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  // shelf quota notices surface as a toast unless the shelves dialog (which shows them inline) is open
  useEffect(() => {
    if (shelvesNotice && !shelvesModalOpen) {
      setToast({ text: shelvesNotice, tone: 'warn' });
      dismissNotice();
    }
  }, [shelvesNotice, shelvesModalOpen, dismissNotice]);

  // ---- reader / preview wiring (all callbacks are stable so memo(BookCard) works) ----
  const handleOpenReader = useCallback((pub: Publication, initialPage = 1) => {
    const next = [slimPublication(pub), ...recentRef.current.filter((p) => p.id !== pub.id)].slice(0, MAX_RECENT);
    recentRef.current = next;
    setRecentPubs(next);
    writeJson(RECENT_KEY, next);

    readerPubRef.current = pub;
    // The drawer closes when the reader opens: one Esc closes exactly one layer, and a native
    // modal <dialog> would otherwise keep the reader inert.
    setSelectedPublication(null);
    setReaderState({ pub, initialPage });
  }, []);

  const handleCloseReader = useCallback(() => {
    readerPubRef.current = null;
    setReaderState(null);
  }, []);

  const handleReaderPagePersist = useCallback(
    (page: number) => {
      const pub = readerPubRef.current;
      if (pub) setReadingPage(pub, page);
    },
    [setReadingPage]
  );

  const handleSelect = useCallback((pub: Publication) => setSelectedPublication(pub), []);
  const handleCloseDrawer = useCallback(() => setSelectedPublication(null), []);

  const handleReadPdf = useCallback(
    (pub: Publication) => {
      const saved = progressRef.current[pub.id]?.page;
      handleOpenReader(pub, saved && saved > 1 ? saved : 1);
    },
    [handleOpenReader]
  );

  const handleOpenReaderFromDrawer = useCallback(
    (pub: Publication, page?: number) => handleOpenReader(pub, page ?? 1),
    [handleOpenReader]
  );

  const handleQuickSave = useCallback(
    (pub: Publication) => {
      const added = toggleInShelf('favorites', pub);
      setToast({ text: added ? 'Guardada en «Lecturas esenciales»' : 'Quitada de «Lecturas esenciales»', tone: 'ok' });
    },
    [toggleInShelf]
  );

  const handleCloseShelves = useCallback(() => {
    setShelvesModalOpen(false);
    dismissNotice();
  }, [dismissNotice]);

  const handleTopic = useCallback(
    (topic: string) => {
      setQuery(topic);
      document.getElementById('catalogo')?.scrollIntoView({ block: 'start' });
    },
    [setQuery]
  );

  const handleSearchLive = useCallback(() => {
    void searchLive(catalog.filters.query);
  }, [searchLive, catalog.filters.query]);

  const handleShowWithoutPdf = useCallback(() => updateFilters({ onlyWithPdf: false }), [updateFilters]);
  const handleToggleOnlyPdf = useCallback(
    () => updateFilters({ onlyWithPdf: !catalog.filters.onlyWithPdf }),
    [updateFilters, catalog.filters.onlyWithPdf]
  );
  const handleYearChange = useCallback(
    (yearFrom: number | null, yearTo: number | null) => updateFilters({ yearFrom, yearTo }),
    [updateFilters]
  );
  const handleSortChange = useCallback((sortBy: CatalogFilters['sortBy']) => updateFilters({ sortBy }), [updateFilters]);
  const handleCloseMobileFilters = useCallback(() => setMobileFiltersOpen(false), []);
  const handleOpenMobileFilters = useCallback(() => setMobileFiltersOpen(true), []);
  const handleToggleSidebar = useCallback(() => setShowDesktopSidebar((s) => !s), []);
  const handleOpenShelves = useCallback(() => setShelvesModalOpen(true), []);
  const handleSetCollections = useCallback((codes: string[]) => setFacetValues('collections', codes), [setFacetValues]);

  // ---- "Continuar leyendo" ----
  const continueEntries = useMemo<ContinueEntry[]>(() => {
    const index = new Map<string, Publication>();
    for (const pub of recentPubs) index.set(pub.id, pub);
    for (const item of shelfItems) index.set(item.publicationId, item.publication);
    for (const pub of catalog.knownPublications) index.set(pub.id, pub);

    return Object.entries(progressMap)
      .filter(([, progress]) => progress.page > 1)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .flatMap(([id, progress]) => {
        const publication = index.get(id);
        return publication && publication.pdfUrl ? [{ publication, progress }] : [];
      })
      .slice(0, 8);
  }, [progressMap, recentPubs, shelfItems, catalog.knownPublications]);

  // ---- active filter chips ----
  const { filters, stats } = catalog;
  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];
    for (const areaId of filters.oecdAreas) {
      chips.push({ key: `area-${areaId}`, label: getArea(areaId).label, onRemove: () => toggleFacet('oecdAreas', areaId) });
    }
    for (const lang of filters.languages) {
      chips.push({
        key: `lang-${lang}`,
        label: `Idioma: ${LANGUAGE_LABELS[lang as LanguageCode] ?? lang}`,
        onRemove: () => toggleFacet('languages', lang)
      });
    }
    for (const country of filters.countries) {
      chips.push({ key: `country-${country}`, label: `País: ${country}`, onRemove: () => toggleFacet('countries', country) });
    }
    for (const type of filters.docTypes) {
      chips.push({
        key: `type-${type}`,
        label: `Tipo: ${DOCTYPE_LABELS[type as DocumentType] ?? type}`,
        onRemove: () => toggleFacet('docTypes', type)
      });
    }
    for (const code of filters.collections) {
      const label = sourceInfo(code, stats.collections.find((c) => c.value === code)?.label).label;
      chips.push({ key: `col-${code}`, label: `Repositorio: ${label}`, onRemove: () => toggleFacet('collections', code) });
    }
    if (filters.yearFrom !== null || filters.yearTo !== null) {
      chips.push({
        key: 'years',
        label: `Años: ${filters.yearFrom ?? '…'}–${filters.yearTo ?? '…'}`,
        onRemove: () => updateFilters({ yearFrom: null, yearTo: null })
      });
    }
    return chips;
  }, [filters, stats.collections, toggleFacet, updateFilters]);

  // "Recién llegados" only makes sense for the default newest-first order and an empty search
  const showShelf = catalog.effectiveQuery.trim() === '' && filters.sortBy === 'year-desc';
  const hasFacetFilters =
    filters.oecdAreas.length > 0 ||
    filters.languages.length > 0 ||
    filters.countries.length > 0 ||
    filters.docTypes.length > 0 ||
    filters.collections.length > 0 ||
    filters.yearFrom !== null ||
    filters.yearTo !== null;
  const recentShelfItems = useMemo(
    () => (catalog.items.some((p) => Boolean(p.coverUrl)) || hasFacetFilters ? catalog.items : shelfCovers),
    [catalog.items, hasFacetFilters, shelfCovers]
  );

  const drawerItems = selectedPublication ? getPublicationShelves(selectedPublication.id) : [];

  return (
    <div className="archive-texture flex min-h-dvh flex-col">
      <a href="#catalogo" className="skip-link">
        Saltar al catálogo
      </a>

      <Header
        query={filters.query}
        onQueryChange={setQuery}
        getSuggestions={catalog.getSuggestions}
        savedCount={savedPublicationIds.size}
        onOpenShelves={handleOpenShelves}
        darkMode={darkMode}
        onToggleDarkMode={handleToggleDarkMode}
      />

      <section className="border-b" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
        <div className="mx-auto max-w-[1440px] px-4 pb-1 pt-4 sm:px-6 sm:pt-6">
          <div className="flex items-center gap-5">
            <div className="hidden shrink-0 sm:block">
              <ColeebriLogo size={72} />
            </div>
            <div className="min-w-0">
              <h1 className="font-editorial text-balance text-[1.375rem] font-semibold leading-tight tracking-tight sm:text-4xl">
                Libros y artículos científicos, listos para leer
              </h1>
              <p className="mt-1.5 hidden max-w-2xl text-sm sm:block sm:text-base" style={{ color: 'var(--text-secondary)' }}>
                Obras de acceso abierto de repositorios académicos de Iberoamérica. Sin registro y sin descargas: abre y lee.
              </p>
              <div className="quickbar-scroll mt-3 hidden items-center gap-2 sm:flex sm:flex-wrap">
                <span className="hidden shrink-0 text-sm sm:inline" style={{ color: 'var(--text-muted)' }}>
                  Temas:
                </span>
                {TOPICS.map((topic) => (
                  <button key={topic} type="button" className="chip shrink-0" onClick={() => handleTopic(topic)}>
                    {topic}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {showShelf ? (
            <div className="mt-2 sm:mt-4">
              <RecentShelf items={recentShelfItems} loading={catalog.loading && recentShelfItems.length === 0} onSelect={handleSelect} />
            </div>
          ) : null}
        </div>
      </section>

      <main
        id="catalogo"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row"
      >
        <FacetSidebar
          stats={stats}
          filters={filters}
          activeFilterCount={catalog.activeFilterCount}
          onToggleFacet={toggleFacet}
          onYearChange={handleYearChange}
          onToggleOnlyPdf={handleToggleOnlyPdf}
          onReset={resetFilters}
          mobileOpen={mobileFiltersOpen}
          onCloseMobile={handleCloseMobileFilters}
          desktopVisible={showDesktopSidebar}
        />

        <div className="min-w-0 flex-1">
          <QuickFilterBar
            stats={stats}
            filters={filters}
            onSetLanguages={(values) => setFacetValues('languages', values)}
            onSetCountries={(values) => setFacetValues('countries', values)}
            onSetCollections={handleSetCollections}
            onYearChange={handleYearChange}
            onToggleOnlyPdf={handleToggleOnlyPdf}
            onOpenAllFilters={handleOpenMobileFilters}
            showSidebar={showDesktopSidebar}
            onToggleSidebar={handleToggleSidebar}
          />

          {activeChips.length > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtros activos">
              {activeChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.onRemove}
                  className="chip"
                  aria-pressed="true"
                  aria-label={`Quitar filtro: ${chip.label}`}
                >
                  <span>{chip.label}</span>
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}

          {catalog.effectiveQuery.trim() === '' ? (
            <ContinueReading entries={continueEntries} onRead={handleReadPdf} onSelect={handleSelect} />
          ) : null}

          <CatalogGrid
            items={catalog.items}
            total={catalog.total}
            loading={catalog.loading}
            refreshing={catalog.refreshing}
            loadingMore={catalog.loadingMore}
            hasMore={catalog.hasMore}
            loadMoreError={catalog.loadMoreError}
            onLoadMore={catalog.loadMore}
            errorMessage={catalog.errorMessage}
            onRetry={catalog.reload}
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            sortBy={filters.sortBy}
            onSortChange={handleSortChange}
            savedIds={savedPublicationIds}
            progressMap={progressMap}
            onSelect={handleSelect}
            onQuickSave={handleQuickSave}
            onResetFilters={resetFilters}
            onlyWithPdf={filters.onlyWithPdf}
            onShowWithoutPdf={handleShowWithoutPdf}
            query={catalog.effectiveQuery}
            canSearchLive={catalog.effectiveQuery.trim().length >= 2}
            liveSearching={catalog.liveSearching}
            onSearchLive={handleSearchLive}
            liveItems={catalog.liveItems}
            liveError={catalog.liveError}
            onClearLive={clearLive}
          />
        </div>
      </main>

      <footer
        className="border-t px-4 py-6 text-sm"
        style={{ borderColor: 'var(--border-hairline)', color: 'var(--text-muted)', paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto flex max-w-[1440px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-3xl">
            Coleebri reúne libros y artículos científicos de acceso abierto de SciELO, DOAB, Redalyc, OpenAlex y repositorios universitarios. Su imagen se inspira en el colibrí de la Universidad Pedagógica Nacional de Colombia.
          </p>
          <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => setSyncModalOpen(true)}>
            Estado del catálogo
          </button>
        </div>
      </footer>

      {selectedPublication ? (
        <ErrorBoundary
          fallback={null}
          resetKey={selectedPublication.id}
          onError={() => {
            setSelectedPublication(null);
            setToast({ text: 'No se pudo abrir la ficha. Revisa tu conexión e inténtalo de nuevo.', tone: 'warn' });
          }}
        >
          <Suspense fallback={<LoadingOverlay />}>
            <PreviewDrawer
              key={selectedPublication.id}
              publication={selectedPublication}
              shelves={shelves}
              publicationShelfItems={drawerItems}
              resumePage={progressMap[selectedPublication.id]?.page}
              onClose={handleCloseDrawer}
              onOpenReader={handleOpenReaderFromDrawer}
              onToggleShelf={toggleInShelf}
              onSaveNote={updateNote}
              onKeywordClick={setQuery}
            />
          </Suspense>
        </ErrorBoundary>
      ) : null}

      {readerState ? (
        <ErrorBoundary
          fallback={null}
          resetKey={readerState.pub.id}
          onError={() => {
            handleCloseReader();
            setToast({ text: 'No se pudo abrir el lector. Revisa tu conexión e inténtalo de nuevo.', tone: 'warn' });
          }}
        >
          <Suspense fallback={<LoadingOverlay />}>
            <PdfReaderModal
              publication={readerState.pub}
              initialPage={readerState.initialPage}
              onClose={handleCloseReader}
              onPagePersist={handleReaderPagePersist}
            />
          </Suspense>
        </ErrorBoundary>
      ) : null}

      {shelvesModalOpen ? (
        <ErrorBoundary
          fallback={null}
          onError={() => {
            setShelvesModalOpen(false);
            setToast({ text: 'No se pudieron abrir las estanterías. Revisa tu conexión.', tone: 'warn' });
          }}
        >
          <Suspense fallback={<LoadingOverlay />}>
            <ShelvesModal
              onClose={handleCloseShelves}
              shelves={shelves}
              shelfItems={shelfItems}
              syncedWithD1={syncedWithD1}
              notice={shelvesNotice}
              onCreateShelf={createShelf}
              onDeleteShelf={deleteShelf}
              onRemoveItem={toggleInShelf}
              onSelectPublication={handleSelect}
              onOpenReader={handleOpenReaderFromDrawer}
              onUpdateNote={updateNote}
            />
          </Suspense>
        </ErrorBoundary>
      ) : null}

      {syncModalOpen ? (
        <ErrorBoundary
          fallback={null}
          onError={() => {
            setSyncModalOpen(false);
            setToast({ text: 'No se pudo abrir el estado del catálogo. Revisa tu conexión.', tone: 'warn' });
          }}
        >
          <Suspense fallback={<LoadingOverlay />}>
            <SyncStatusModal
              onClose={() => setSyncModalOpen(false)}
              onSyncCompleted={catalog.reload}
              catalogSize={stats.total}
              withPdf={stats.withPdf}
              source={catalog.mode}
            />
          </Suspense>
        </ErrorBoundary>
      ) : null}

      {toast ? (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => setToast(null)}
            aria-label="Cerrar aviso"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <OfflineBanner />
    </div>
  );
}

export default App;
