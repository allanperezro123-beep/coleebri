import { memo, useEffect, useId, useRef } from 'react';
import { ArrowUpDown, FileImage, Globe2, LayoutGrid, List, Loader2, SearchX, TriangleAlert, X } from 'lucide-react';
import type { ProgressMap } from '../hooks/useReadingProgress';
import type { CatalogFilters, Publication } from '../types/publication';
import { BookCard } from './BookCard';

interface CatalogGridProps {
  items: Publication[];
  total: number;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMoreError: boolean;
  onLoadMore: () => void;
  errorMessage: string | null;
  onRetry: () => void;
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  enableLivePdfRender: boolean;
  onToggleLivePdfRender: () => void;
  sortBy: CatalogFilters['sortBy'];
  onSortChange: (sort: CatalogFilters['sortBy']) => void;
  savedIds: Set<string>;
  progressMap: ProgressMap;
  onSelect: (pub: Publication) => void;
  onReadPdf: (pub: Publication) => void;
  onQuickSave: (pub: Publication) => void;
  onResetFilters: () => void;
  onlyWithPdf: boolean;
  onShowWithoutPdf: () => void;
  query: string;
  canSearchLive: boolean;
  liveSearching: boolean;
  onSearchLive: () => void;
  liveItems: Publication[];
  liveError: string | null;
  onClearLive: () => void;
}

const GRID_CLASS = 'grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4';

function Skeletons({ viewMode }: { viewMode: 'grid' | 'list' }) {
  if (viewMode === 'list') {
    return (
      <div className="flex flex-col gap-2.5" aria-hidden="true">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="book-card flex h-[92px] items-center gap-3 p-3"
            style={{ contentVisibility: 'visible' }}
          >
            <div className="skeleton h-12 w-1" />
            <div className="flex-1">
              <div className="skeleton h-4 w-4/5" />
              <div className="skeleton mt-2 h-3 w-1/2" />
              <div className="skeleton mt-2 h-3 w-1/3" />
            </div>
            <div className="skeleton h-11 w-20" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={GRID_CLASS} aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="book-card p-3" style={{ contentVisibility: 'visible' }}>
          <div className="skeleton aspect-[3/4] w-full" />
          <div className="skeleton mt-3 h-3 w-1/3" />
          <div className="skeleton mt-2 h-4 w-5/6" />
          <div className="skeleton mt-2 h-3 w-2/3" />
          <div className="skeleton mt-4 h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

export const CatalogGrid = memo(function CatalogGrid({
  items,
  total,
  loading,
  refreshing,
  loadingMore,
  hasMore,
  loadMoreError,
  onLoadMore,
  errorMessage,
  onRetry,
  viewMode,
  onViewModeChange,
  enableLivePdfRender,
  onToggleLivePdfRender,
  sortBy,
  onSortChange,
  savedIds,
  progressMap,
  onSelect,
  onReadPdf,
  onQuickSave,
  onResetFilters,
  onlyWithPdf,
  onShowWithoutPdf,
  query,
  canSearchLive,
  liveSearching,
  onSearchLive,
  liveItems,
  liveError,
  onClearLive
}: CatalogGridProps) {
  const sortId = useId();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  // Infinite loading. The observer is re-created after every load so that, if the sentinel is
  // still near the viewport, it fires again (an observer only reports changes).
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loadMoreError || loadingMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadMoreError, loadingMore, loading, items.length]);

  const renderCards = (list: Publication[], mode: 'grid' | 'list') =>
    list.map((pub) => (
      <BookCard
        key={pub.id}
        publication={pub}
        viewMode={mode}
        enableLivePdfRender={enableLivePdfRender}
        isSaved={savedIds.has(pub.id)}
        progress={progressMap[pub.id]}
        onSelect={onSelect}
        onReadPdf={onReadPdf}
        onQuickSave={onQuickSave}
      />
    ));

  const showEmpty = !loading && items.length === 0;
  const countText = loading
    ? 'Cargando obras…'
    : total === 0
      ? 'Sin obras para mostrar'
      : `Mostrando ${items.length} de ${total} ${total === 1 ? 'obra' : 'obras'}`;

  return (
    <div className="min-w-0">
      <div
        className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border px-3.5 py-2"
        style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-hairline)' }}
      >
        <p role="status" aria-live="polite" className="text-sm font-semibold">
          {countText}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {canSearchLive ? (
            <button type="button" className="btn btn-quiet btn-sm" onClick={onSearchLive} disabled={liveSearching}>
              {liveSearching ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Globe2 className="h-4 w-4" aria-hidden="true" />
              )}
              <span>Buscar también en SciELO</span>
            </button>
          ) : null}

          {viewMode === 'grid' ? (
            <button
              type="button"
              className="chip hidden sm:inline-flex"
              aria-pressed={enableLivePdfRender}
              onClick={onToggleLivePdfRender}
              title="Muestra la primera página del PDF como portada"
            >
              <FileImage className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Portadas desde el PDF</span>
            </button>
          ) : null}

          <div className="relative inline-flex items-center">
            <label htmlFor={sortId} className="sr-only">
              Ordenar por
            </label>
            <ArrowUpDown
              className="pointer-events-none absolute left-2.5 h-3.5 w-3.5"
              style={{ color: 'var(--text-muted)' }}
              aria-hidden="true"
            />
            <select
              id={sortId}
              className="field pl-8"
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value as CatalogFilters['sortBy'])}
            >
              <option value="year-desc">Más recientes</option>
              <option value="citations">Más citados</option>
              <option value="relevance">Relevancia</option>
              <option value="title">Título (A–Z)</option>
              <option value="year-asc">Más antiguos</option>
            </select>
          </div>

          <div
            className="inline-flex gap-0.5 rounded-md border p-0.5"
            style={{ borderColor: 'var(--border-hairline)', backgroundColor: 'var(--bg-surface)' }}
            role="group"
            aria-label="Vista de resultados"
          >
            <button
              type="button"
              className="chip border-transparent"
              style={{ minWidth: '2.75rem', justifyContent: 'center' }}
              aria-pressed={viewMode === 'grid'}
              aria-label="Cuadrícula"
              onClick={() => onViewModeChange('grid')}
            >
              <LayoutGrid className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="chip border-transparent"
              style={{ minWidth: '2.75rem', justifyContent: 'center' }}
              aria-pressed={viewMode === 'list'}
              aria-label="Lista compacta"
              onClick={() => onViewModeChange('list')}
            >
              <List className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {errorMessage ? (
        <div className="callout mb-4" data-tone="error" role="alert">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--danger)' }} aria-hidden="true" />
          <div className="flex-1">
            <p>{errorMessage}</p>
            <button type="button" className="btn btn-quiet btn-sm mt-2" onClick={onRetry}>
              Reintentar
            </button>
          </div>
        </div>
      ) : null}

      {liveError ? (
        <div className="callout mb-4" data-tone="warn" role="alert">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--accent-ochre)' }} aria-hidden="true" />
          <p>{liveError}</p>
        </div>
      ) : null}

      {liveItems.length > 0 ? (
        <section className="mb-6" aria-label="Resultados de SciELO en línea">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-editorial text-lg font-semibold">
              También en SciELO <span className="font-code text-sm font-normal">({liveItems.length})</span>
            </h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClearLive}>
              <X className="h-4 w-4" aria-hidden="true" />
              <span>Ocultar</span>
            </button>
          </div>
          {viewMode === 'list' ? (
            <div className="flex flex-col gap-2.5">{renderCards(liveItems, 'list')}</div>
          ) : (
            <div className={GRID_CLASS}>{renderCards(liveItems, 'grid')}</div>
          )}
        </section>
      ) : null}

      {loading ? (
        <Skeletons viewMode={viewMode} />
      ) : showEmpty ? (
        <div
          className="flex flex-col items-center justify-center rounded-md border px-6 py-14 text-center"
          style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-hairline)' }}
        >
          <SearchX className="mb-3 h-9 w-9" style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
          <h2 className="font-editorial text-xl font-semibold">No encontramos obras con esos filtros</h2>
          <p className="mt-1 max-w-md text-sm" style={{ color: 'var(--text-secondary)' }}>
            {query.trim()
              ? `Prueba con otras palabras o quita algún filtro. También puedes buscar «${query.trim()}» directamente en SciELO.`
              : 'Prueba quitando algún filtro para ver más obras.'}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <button type="button" className="btn btn-primary" onClick={onResetFilters}>
              Quitar filtros
            </button>
            {onlyWithPdf ? (
              <button type="button" className="btn btn-quiet" onClick={onShowWithoutPdf}>
                Mostrar también obras sin texto completo
              </button>
            ) : null}
            {canSearchLive ? (
              <button type="button" className="btn btn-quiet" onClick={onSearchLive} disabled={liveSearching}>
                Buscar también en SciELO
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          aria-busy={refreshing}
          style={{ opacity: refreshing ? 0.55 : 1, transition: 'opacity 0.15s' }}
          className={viewMode === 'list' ? 'flex flex-col gap-2.5' : GRID_CLASS}
        >
          {renderCards(items, viewMode)}
        </div>
      )}

      {hasMore && !loading ? (
        <div className="mt-6 flex flex-col items-center gap-2">
          <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
          {loadMoreError ? (
            <p role="alert" className="text-sm" style={{ color: 'var(--danger)' }}>
              No pudimos cargar más obras.
            </p>
          ) : null}
          <button type="button" className="btn btn-quiet" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            <span>{loadingMore ? 'Cargando…' : loadMoreError ? 'Reintentar' : 'Cargar más obras'}</span>
          </button>
        </div>
      ) : items.length > 0 && !loading ? (
        <p className="mt-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Llegaste al final de los resultados.
        </p>
      ) : null}
    </div>
  );
});
