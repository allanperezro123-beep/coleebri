import { useId } from 'react';
import { BookCheck, SlidersHorizontal } from 'lucide-react';
import type { CatalogFilters, CatalogStats, LanguageCode } from '../types/publication';

interface QuickFilterBarProps {
  stats: CatalogStats;
  filters: CatalogFilters;
  /** Replaces the whole selection; an empty array means "Todos". */
  onSetLanguages: (languages: LanguageCode[]) => void;
  onSetCountries: (countries: string[]) => void;
  onYearChange: (from: number | null, to: number | null) => void;
  onToggleOnlyPdf: () => void;
  onOpenAllFilters: () => void;
  showSidebar: boolean;
  onToggleSidebar: () => void;
}

const YEAR_PRESETS = [
  { label: '2020 – hoy', from: 2020, to: null },
  { label: '2015 – 2019', from: 2015, to: 2019 },
  { label: 'Hasta 2014', from: null, to: 2014 }
] as const;

const MULTI = '__multi__';

/** The select shows one value; when the sidebar selected several it shows "Varios (n)". */
function selectValue(values: string[]): string {
  if (values.length === 0) return '';
  return values.length === 1 ? values[0] : MULTI;
}

export function QuickFilterBar({
  stats,
  filters,
  onSetLanguages,
  onSetCountries,
  onYearChange,
  onToggleOnlyPdf,
  onOpenAllFilters,
  showSidebar,
  onToggleSidebar
}: QuickFilterBarProps) {
  const id = useId();

  return (
    <div
      className="mb-4 flex flex-col gap-2 rounded-md border px-3 py-2.5 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between lg:gap-x-3"
      style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-hairline)' }}
      role="group"
      aria-label="Filtros rápidos"
    >
      {/* Phones: two selects side by side, then ONE horizontally scrollable row of chips. */}
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-1 sm:flex-wrap sm:items-center">
        <div className="min-w-0 sm:min-w-[9rem] sm:flex-none">
          <label htmlFor={`${id}-lang`} className="sr-only">
            Idioma
          </label>
          <select
            id={`${id}-lang`}
            className="field w-full"
            value={selectValue(filters.languages)}
            onChange={(event) => {
              const value = event.target.value;
              if (value === MULTI) return;
              onSetLanguages(value ? [value as LanguageCode] : []);
            }}
          >
            <option value="">Idioma: todos</option>
            {filters.languages.length > 1 ? (
              <option value={MULTI}>Idioma: varios ({filters.languages.length})</option>
            ) : null}
            {stats.languages.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label} ({l.count})
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0 sm:min-w-[9rem] sm:flex-none">
          <label htmlFor={`${id}-country`} className="sr-only">
            País
          </label>
          <select
            id={`${id}-country`}
            className="field w-full"
            value={selectValue(filters.countries)}
            onChange={(event) => {
              const value = event.target.value;
              if (value === MULTI) return;
              onSetCountries(value ? [value] : []);
            }}
          >
            <option value="">País: todos</option>
            {filters.countries.length > 1 ? (
              <option value={MULTI}>País: varios ({filters.countries.length})</option>
            ) : null}
            {stats.countries.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label} ({c.count})
              </option>
            ))}
          </select>
        </div>

      </div>

      <div className="quickbar-scroll -mx-3 flex items-center gap-2 overflow-x-auto px-3 pb-0.5 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0 lg:pb-0">
        <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Año de publicación">
          {YEAR_PRESETS.map((preset) => {
            const active = filters.yearFrom === preset.from && filters.yearTo === preset.to;
            return (
              <button
                key={preset.label}
                type="button"
                className="chip shrink-0 whitespace-nowrap"
                aria-pressed={active}
                onClick={() => (active ? onYearChange(null, null) : onYearChange(preset.from, preset.to))}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <button type="button" className="chip shrink-0" aria-pressed={filters.onlyWithPdf} onClick={onToggleOnlyPdf}>
          <BookCheck className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Solo texto completo</span>
        </button>

        <button
          type="button"
          className="chip hidden shrink-0 lg:inline-flex"
          aria-pressed={showSidebar}
          onClick={onToggleSidebar}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Más filtros</span>
        </button>
        <button type="button" className="chip shrink-0 lg:hidden" onClick={onOpenAllFilters}>
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Más filtros</span>
        </button>
      </div>
    </div>
  );
}
