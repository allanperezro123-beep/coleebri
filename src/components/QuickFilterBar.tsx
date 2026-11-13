import { Calendar, Globe, Languages, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { CatalogFilters, CatalogStats, LanguageCode } from '../types/publication';

interface QuickFilterBarProps {
  stats: CatalogStats;
  filters: CatalogFilters;
  onToggleLanguage: (lang: LanguageCode) => void;
  onToggleCountry: (country: string) => void;
  onYearChange: (from: number | null, to: number | null) => void;
  onToggleOnlyPdf: () => void;
  onOpenAllFilters: () => void;
  showSidebar: boolean;
  onToggleSidebar: () => void;
}

export function QuickFilterBar({
  stats,
  filters,
  onToggleLanguage,
  onToggleCountry,
  onYearChange,
  onToggleOnlyPdf,
  onOpenAllFilters,
  showSidebar,
  onToggleSidebar
}: QuickFilterBarProps) {
  const selectedLang = filters.languages[0] || '';
  const selectedCountry = filters.countries[0] || '';

  return (
    <div
      className="mb-4 flex flex-wrap items-center justify-between gap-2.5 rounded-md border px-3 py-2.5 backdrop-blur-xs"
      style={{
        backgroundColor: 'var(--bg-card)',
        borderColor: 'var(--border-hairline)'
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Idioma */}
        <label className="relative inline-flex items-center">
          <Languages
            className="pointer-events-none absolute left-2.5 h-3.5 w-3.5"
            style={{ color: 'var(--accent-upn)' }}
          />
          <select
            value={selectedLang}
            onChange={(e) => {
              const v = e.target.value as LanguageCode | '';
              if (!v) {
                if (selectedLang) onToggleLanguage(selectedLang);
              } else if (v !== selectedLang) {
                if (selectedLang) onToggleLanguage(selectedLang);
                onToggleLanguage(v);
              }
            }}
            className="h-8 rounded border pl-8 pr-6 text-xs font-medium outline-none transition-colors"
            style={{
              borderColor: selectedLang ? 'var(--accent-upn)' : 'var(--border-hairline)',
              backgroundColor: selectedLang ? 'var(--accent-crimson-soft)' : 'var(--bg-surface)',
              color: 'var(--text-primary)'
            }}
            aria-label="Filtrar por idioma"
          >
            <option value="">Idioma: Todos</option>
            {stats.languages.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label} ({l.count})
              </option>
            ))}
          </select>
        </label>

        {/* País */}
        <label className="relative inline-flex items-center">
          <Globe
            className="pointer-events-none absolute left-2.5 h-3.5 w-3.5"
            style={{ color: 'var(--accent-jade)' }}
          />
          <select
            value={selectedCountry}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                if (selectedCountry) onToggleCountry(selectedCountry);
              } else if (v !== selectedCountry) {
                if (selectedCountry) onToggleCountry(selectedCountry);
                onToggleCountry(v);
              }
            }}
            className="h-8 rounded border pl-8 pr-6 text-xs font-medium outline-none transition-colors"
            style={{
              borderColor: selectedCountry ? 'var(--accent-jade)' : 'var(--border-hairline)',
              backgroundColor: selectedCountry ? 'rgba(46, 139, 116, 0.11)' : 'var(--bg-surface)',
              color: 'var(--text-primary)'
            }}
            aria-label="Filtrar por país"
          >
            <option value="">País: Todos</option>
            {stats.countries.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label} ({c.count})
              </option>
            ))}
          </select>
        </label>

        {/* Fecha / Año rápido */}
        <div className="inline-flex items-center gap-1">
          <Calendar className="hidden h-3.5 w-3.5 sm:inline" style={{ color: 'var(--accent-ochre)' }} />
          {[
            { label: '2020–Hoy', from: 2020, to: null },
            { label: '2015–19', from: 2015, to: 2019 },
            { label: '≤ 2014', from: null, to: 2014 }
          ].map((preset) => {
            const active = filters.yearFrom === preset.from && filters.yearTo === preset.to;
            return (
              <button
                key={preset.label}
                type="button"
                onClick={() => onYearChange(active ? null : preset.from, active ? null : preset.to)}
                className="h-8 rounded border px-2.5 font-code text-[11px] font-medium transition-colors"
                style={{
                  borderColor: active ? 'var(--accent-upn)' : 'var(--border-hairline)',
                  backgroundColor: active ? 'var(--accent-crimson-soft)' : 'var(--bg-surface)',
                  color: active ? 'var(--accent-upn)' : 'var(--text-secondary)'
                }}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleOnlyPdf}
          className="inline-flex h-8 items-center gap-1.5 rounded border px-2.5 text-xs font-medium transition-colors"
          style={{
            borderColor: filters.onlyWithPdf ? 'var(--accent-jade)' : 'var(--border-hairline)',
            backgroundColor: filters.onlyWithPdf ? 'rgba(46, 139, 116, 0.12)' : 'var(--bg-surface)',
            color: filters.onlyWithPdf ? 'var(--accent-jade)' : 'var(--text-secondary)'
          }}
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>Lectura directa ({stats.withPdf})</span>
        </button>

        {/* Desktop toggle sidebar vs Mobile drawer */}
        <button
          type="button"
          onClick={onToggleSidebar}
          className="hidden h-8 items-center gap-1.5 rounded border px-2.5 text-xs font-medium transition-colors lg:inline-flex"
          style={{
            borderColor: showSidebar ? 'var(--accent-upn)' : 'var(--border-hairline)',
            backgroundColor: showSidebar ? 'var(--accent-crimson-soft)' : 'var(--bg-surface)',
            color: showSidebar ? 'var(--accent-upn)' : 'var(--text-secondary)'
          }}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span>{showSidebar ? 'Ocultar áreas' : 'Áreas y colecciones'}</span>
        </button>

        <button
          type="button"
          onClick={onOpenAllFilters}
          className="inline-flex h-8 items-center gap-1.5 rounded border px-2.5 text-xs font-medium lg:hidden"
          style={{
            borderColor: 'var(--border-hairline)',
            backgroundColor: 'var(--bg-surface)',
            color: 'var(--text-primary)'
          }}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span>Más filtros</span>
        </button>
      </div>
    </div>
  );
}
