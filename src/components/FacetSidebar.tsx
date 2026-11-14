import { useEffect, useId } from 'react';
import { RotateCcw } from 'lucide-react';
import { areaFillColor, areaTextColor } from '../lib/publication';
import { sourceInfo } from '../lib/sources';
import type {
  CatalogFilters,
  CatalogStats,
  DocumentType,
  LanguageCode,
  OecdAreaId
} from '../types/publication';
import { Modal, ModalHeader } from './Modal';

interface FacetSidebarProps {
  stats: CatalogStats;
  filters: CatalogFilters;
  activeFilterCount: number;
  onToggleFacet: <K extends 'oecdAreas' | 'languages' | 'countries' | 'docTypes' | 'collections'>(
    key: K,
    value: CatalogFilters[K][number]
  ) => void;
  onYearChange: (from: number | null, to: number | null) => void;
  onToggleOnlyPdf: () => void;
  onReset: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  desktopVisible?: boolean;
}

const YEAR_PRESETS = [
  { label: '2020 – hoy', from: 2020, to: null },
  { label: '2015 – 2019', from: 2015, to: 2019 },
  { label: 'Hasta 2014', from: null, to: 2014 }
] as const;

type ContentProps = Omit<FacetSidebarProps, 'mobileOpen' | 'onCloseMobile' | 'desktopVisible'>;

function FacetContent({
  stats,
  filters,
  activeFilterCount,
  onToggleFacet,
  onYearChange,
  onToggleOnlyPdf,
  onReset
}: ContentProps) {
  const uid = useId();

  const parseYear = (raw: string): number | null => {
    const value = Number.parseInt(raw, 10);
    return Number.isNaN(value) ? null : value;
  };

  return (
    <div className="flex flex-col gap-5">
      {activeFilterCount > 0 ? (
        <button type="button" onClick={onReset} className="btn btn-quiet btn-sm self-start">
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Quitar filtros ({activeFilterCount})</span>
        </button>
      ) : null}

      <label
        className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded border px-3 py-2"
        style={{
          borderColor: filters.onlyWithPdf ? 'var(--accent-primary)' : 'var(--border-hairline)',
          backgroundColor: filters.onlyWithPdf ? 'var(--accent-primary-soft)' : 'var(--bg-surface)'
        }}
      >
        <span>
          <span className="block text-sm font-semibold">Solo texto completo</span>
          <span className="block text-xs" style={{ color: 'var(--text-muted)' }}>
            {stats.withPdf} obras se pueden leer aquí mismo
          </span>
        </span>
        <input
          type="checkbox"
          checked={filters.onlyWithPdf}
          onChange={onToggleOnlyPdf}
          className="h-5 w-5 shrink-0"
          style={{ accentColor: 'var(--accent-primary)' }}
        />
      </label>

      {stats.collections.length > 0 ? (
        <section aria-labelledby={`${uid}-collections`}>
          <h3 id={`${uid}-collections`} className="micro mb-2">
            Repositorio de origen
          </h3>
          <div className="flex flex-col gap-0.5">
            {stats.collections.map((bucket) => {
              const selected = filters.collections.includes(bucket.value);
              const source = sourceInfo(bucket.value, bucket.label);
              return (
                <button
                  key={bucket.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onToggleFacet('collections', bucket.value)}
                  className="flex min-h-11 items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-[var(--bg-hover)] sm:min-h-10"
                  style={{
                    backgroundColor: selected ? 'var(--bg-hover)' : undefined,
                    boxShadow: selected ? 'inset 3px 0 0 var(--accent-primary)' : undefined,
                    color: selected ? 'var(--text-primary)' : 'var(--text-secondary)'
                  }}
                >
                  <span className="min-w-0">
                    <span className={`block truncate ${selected ? 'font-semibold' : ''}`}>{source.label}</span>
                    {source.description ? (
                      <span className="block text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                        {source.description}
                      </span>
                    ) : null}
                  </span>
                  <span className="font-code shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {bucket.count}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section aria-labelledby={`${uid}-areas`}>
        <h3 id={`${uid}-areas`} className="micro mb-2">
          Área temática
        </h3>
        <div className="flex flex-col gap-0.5">
          {stats.oecdAreas.map((bucket) => {
            const areaId = bucket.value as OecdAreaId;
            const selected = filters.oecdAreas.includes(areaId);
            return (
              <button
                key={bucket.value}
                type="button"
                aria-pressed={selected}
                onClick={() => onToggleFacet('oecdAreas', areaId)}
                className="flex min-h-11 items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-[var(--bg-hover)] sm:min-h-9"
                style={{
                  backgroundColor: selected ? 'var(--bg-hover)' : undefined,
                  boxShadow: selected ? `inset 3px 0 0 ${areaFillColor(areaId)}` : undefined
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: areaFillColor(areaId) }}
                    aria-hidden="true"
                  />
                  <span
                    className={selected ? 'font-semibold' : ''}
                    style={selected ? { color: areaTextColor(areaId) } : undefined}
                  >
                    {bucket.label}
                  </span>
                </span>
                <span className="font-code text-xs" style={{ color: 'var(--text-muted)' }}>
                  {bucket.count}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby={`${uid}-types`}>
        <h3 id={`${uid}-types`} className="micro mb-2">
          Tipo de obra
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {stats.docTypes.map((bucket) => (
            <button
              key={bucket.value}
              type="button"
              className="chip"
              aria-pressed={filters.docTypes.includes(bucket.value as DocumentType)}
              onClick={() => onToggleFacet('docTypes', bucket.value as DocumentType)}
            >
              <span>{bucket.label}</span>
              <span className="chip-count">{bucket.count}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby={`${uid}-langs`}>
        <h3 id={`${uid}-langs`} className="micro mb-2">
          Idioma
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {stats.languages.map((bucket) => (
            <button
              key={bucket.value}
              type="button"
              className="chip"
              aria-pressed={filters.languages.includes(bucket.value as LanguageCode)}
              onClick={() => onToggleFacet('languages', bucket.value as LanguageCode)}
            >
              <span>{bucket.label}</span>
              <span className="chip-count">{bucket.count}</span>
            </button>
          ))}
        </div>
      </section>

      {stats.countries.length > 0 ? (
        <section aria-labelledby={`${uid}-countries`}>
          <h3 id={`${uid}-countries`} className="micro mb-2">
            País
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {stats.countries.map((bucket) => (
              <button
                key={bucket.value}
                type="button"
                className="chip"
                aria-pressed={filters.countries.includes(bucket.value)}
                onClick={() => onToggleFacet('countries', bucket.value)}
              >
                <span>{bucket.label}</span>
                <span className="chip-count">{bucket.count}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby={`${uid}-years`}>
        <h3 id={`${uid}-years`} className="micro mb-2">
          Año de publicación
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor={`${uid}-from`} className="mb-1 block text-xs" style={{ color: 'var(--text-muted)' }}>
              Desde
            </label>
            <input
              id={`${uid}-from`}
              type="number"
              inputMode="numeric"
              min={stats.yearMin}
              max={stats.yearMax}
              value={filters.yearFrom ?? ''}
              onChange={(e) => onYearChange(parseYear(e.target.value), filters.yearTo)}
              placeholder={String(stats.yearMin)}
              className="field font-code"
            />
          </div>
          <div>
            <label htmlFor={`${uid}-to`} className="mb-1 block text-xs" style={{ color: 'var(--text-muted)' }}>
              Hasta
            </label>
            <input
              id={`${uid}-to`}
              type="number"
              inputMode="numeric"
              min={stats.yearMin}
              max={stats.yearMax}
              value={filters.yearTo ?? ''}
              onChange={(e) => onYearChange(filters.yearFrom, parseYear(e.target.value))}
              placeholder={String(stats.yearMax)}
              className="field font-code"
            />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {YEAR_PRESETS.map((preset) => {
            const active = filters.yearFrom === preset.from && filters.yearTo === preset.to;
            return (
              <button
                key={preset.label}
                type="button"
                className="chip"
                aria-pressed={active}
                onClick={() => (active ? onYearChange(null, null) : onYearChange(preset.from, preset.to))}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </section>

    </div>
  );
}

export function FacetSidebar({
  mobileOpen,
  onCloseMobile,
  desktopVisible = false,
  ...contentProps
}: FacetSidebarProps) {
  const titleId = useId();

  // The sheet is for small screens only: close it if the window grows to the desktop layout.
  useEffect(() => {
    if (!mobileOpen) return;
    const query = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (query.matches) onCloseMobile();
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [mobileOpen, onCloseMobile]);

  return (
    <>
      {desktopVisible ? (
        <aside
          aria-labelledby={`${titleId}-desktop`}
          className="hidden w-72 shrink-0 rounded-md border p-4 lg:block lg:self-start"
          style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-hairline)' }}
        >
          <h2 id={`${titleId}-desktop`} className="font-editorial mb-4 text-base font-semibold">
            Filtros
          </h2>
          <FacetContent {...contentProps} />
        </aside>
      ) : null}

      {mobileOpen ? (
        <Modal variant="left" labelledBy={titleId} onClose={onCloseMobile}>
          <ModalHeader titleId={titleId} title="Filtros" onClose={onCloseMobile} closeLabel="Cerrar filtros" />
          <div className="modal-body p-4">
            <FacetContent {...contentProps} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
