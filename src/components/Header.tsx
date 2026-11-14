import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Bookmark, Moon, Search, Sun, X } from 'lucide-react';
import type { AutocompleteSuggestion } from '../hooks/useCatalog';
import { ColeebriLogo } from './ColeebriLogo';

interface HeaderProps {
  query: string;
  onQueryChange: (value: string) => void;
  getSuggestions: (value: string) => AutocompleteSuggestion[];
  savedCount: number;
  onOpenShelves: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

export function Header({
  query,
  onQueryChange,
  getSuggestions,
  savedCount,
  onOpenShelves,
  darkMode,
  onToggleDarkMode
}: HeaderProps) {
  const inputId = useId();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  /** Phones only: the single-row header swaps the brand + actions for the search field. */
  const [searchOpen, setSearchOpen] = useState(false);
  const wasSearchOpen = useRef(false);

  const suggestions = useMemo(() => (open ? getSuggestions(query) : []), [open, query, getSuggestions]);
  const expanded = open && suggestions.length > 0;
  const optionId = (index: number) => `${listboxId}-opt-${index}`;

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
    else if (wasSearchOpen.current) searchToggleRef.current?.focus();
    wasSearchOpen.current = searchOpen;
  }, [searchOpen]);

  const choose = (suggestion: AutocompleteSuggestion) => {
    onQueryChange(suggestion.value);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const count = suggestions.length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) setOpen(true);
        else if (count > 0) setActiveIndex((i) => (i + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (count > 0) setActiveIndex((i) => (i <= 0 ? count - 1 : i - 1));
        break;
      case 'Enter':
        if (expanded && activeIndex >= 0 && suggestions[activeIndex]) {
          event.preventDefault();
          choose(suggestions[activeIndex]);
        } else {
          setOpen(false);
        }
        break;
      case 'Escape':
        if (expanded) {
          event.preventDefault();
          setOpen(false);
          setActiveIndex(-1);
        } else if (searchOpen) {
          setSearchOpen(false);
        }
        break;
      default:
        break;
    }
  };

  return (
    <header className="site-header sticky top-0 z-30">
      <div className="mx-auto flex max-w-[1440px] items-center gap-2 px-4 py-2 sm:px-6 md:gap-4 md:py-3">
        {/* Brand */}
        <div className={`${searchOpen ? 'hidden md:flex' : 'flex'} shrink-0 items-center`}>
          <ColeebriLogo size={40} showWordmark wordmarkClassName="hidden sm:flex" />
        </div>

        {/* Search combobox (always visible from md up; on phones it replaces the brand row) */}
        <div
          className={`${searchOpen ? 'flex' : 'hidden'} min-w-0 flex-1 items-center gap-2 md:mx-auto md:flex md:max-w-2xl`}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setOpen(false);
              setActiveIndex(-1);
            }
          }}
        >
          <form
            role="search"
            className="relative min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              setOpen(false);
              inputRef.current?.blur();
              if (searchOpen) setSearchOpen(false);
            }}
          >
            <label htmlFor={inputId} className="sr-only">
              Buscar en el catálogo por título, autor, DOI o tema
            </label>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
              style={{ color: 'var(--text-muted)' }}
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              role="combobox"
              aria-expanded={expanded}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="search"
              value={query}
              onFocus={() => setOpen(true)}
              onChange={(event) => {
                onQueryChange(event.target.value);
                setOpen(true);
                setActiveIndex(-1);
              }}
              onKeyDown={onKeyDown}
              placeholder="Buscar por título, autor, tema o DOI"
              className="field pl-9 pr-11 md:min-h-11"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  onQueryChange('');
                  setOpen(false);
                  inputRef.current?.focus();
                }}
                className="absolute right-0 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Borrar búsqueda"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}

            <ul
              id={listboxId}
              role="listbox"
              aria-label="Sugerencias de búsqueda"
              hidden={!expanded}
              className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-md border py-1"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border-strong)',
                boxShadow: 'var(--shadow-pop)'
              }}
            >
              {suggestions.map((suggestion, index) => (
                <li
                  key={`${suggestion.category}-${suggestion.value}`}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(suggestion)}
                  onMouseMove={() => setActiveIndex(index)}
                  className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm"
                  style={{ backgroundColor: index === activeIndex ? 'var(--bg-hover)' : 'transparent' }}
                >
                  <span className="truncate font-medium">{suggestion.label}</span>
                  <span className="micro shrink-0">{suggestion.category}</span>
                </li>
              ))}
            </ul>
            <div className="sr-only" role="status" aria-live="polite">
              {expanded ? `${suggestions.length} sugerencias disponibles` : ''}
            </div>
          </form>

          <button
            type="button"
            onClick={() => setSearchOpen(false)}
            className="btn btn-ghost btn-sm shrink-0 md:hidden"
          >
            Cerrar
          </button>
        </div>

        {/* Actions */}
        <div className={`${searchOpen ? 'hidden md:flex' : 'flex'} ml-auto shrink-0 items-center gap-1.5 md:ml-0`}>
          <button
            ref={searchToggleRef}
            type="button"
            onClick={() => setSearchOpen(true)}
            className="btn btn-quiet btn-icon md:hidden"
            aria-label="Buscar en el catálogo"
            aria-expanded={searchOpen}
          >
            <Search className="anim-icon-search h-4 w-4" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={onOpenShelves}
            className="btn btn-quiet btn-sm"
            aria-label={`Mis estanterías, ${savedCount} ${savedCount === 1 ? 'obra guardada' : 'obras guardadas'}`}
          >
            <Bookmark className="anim-icon-bookmark h-4 w-4" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
            <span className="hidden sm:inline">Estanterías</span>
            <span
              className="font-code rounded px-1.5 py-0.5 text-xs"
              style={{ backgroundColor: 'var(--accent-primary-soft)', color: 'var(--accent-primary)' }}
              aria-hidden="true"
            >
              {savedCount}
            </span>
          </button>

          <button
            type="button"
            onClick={onToggleDarkMode}
            className="btn btn-quiet btn-icon btn-sm"
            aria-label={darkMode ? 'Cambiar al tema claro' : 'Cambiar al tema oscuro'}
          >
            {darkMode ? (
              <Sun className="anim-icon-theme h-4 w-4" aria-hidden="true" />
            ) : (
              <Moon className="anim-icon-theme h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
