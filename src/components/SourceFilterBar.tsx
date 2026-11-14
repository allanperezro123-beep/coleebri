import { memo, useMemo } from 'react';
import type { FacetBucket } from '../types/publication';
import { SOURCE_ORDER, isScieloJournalCode, sourceInfo } from '../lib/sources';

interface SourceFilterBarProps {
  /** `collections` facet from the API (or computed from the bundled seed). */
  buckets: FacetBucket[];
  /** Currently selected collection codes. */
  selected: string[];
  /** Replaces the whole `collections` selection; an empty array means "Todas". */
  onSelect: (codes: string[]) => void;
}

interface SourceChip {
  key: string;
  label: string;
  codes: string[];
  title: string;
}

const MAX_CODES_PER_CHIP = 10; // the API accepts at most 10 values per list filter

/**
 * One-tap repository filter ("Todas · SciELO Books · Dialnet · …"). Only repositories that exist in
 * the catalogue (or are currently selected, so they can always be un-selected) get a chip.
 */
export const SourceFilterBar = memo(function SourceFilterBar({ buckets, selected, onSelect }: SourceFilterBarProps) {
  const chips = useMemo<SourceChip[]>(() => {
    const present = new Map(buckets.filter((b) => b.count > 0 || selected.includes(b.value)).map((b) => [b.value, b]));
    for (const code of selected) if (!present.has(code)) present.set(code, { value: code, label: code, count: 0 });

    const out: SourceChip[] = [];
    const used = new Set<string>();

    for (const code of SOURCE_ORDER) {
      if (!present.has(code)) continue;
      const info = sourceInfo(code, present.get(code)?.label);
      out.push({ key: code, label: info.short, codes: [code], title: info.description });
      used.add(code);
    }

    // SciELO journal collections (scielo-col, scielo-mex, …) share one chip.
    const journals = [...present.keys()].filter(isScieloJournalCode).slice(0, MAX_CODES_PER_CHIP);
    if (journals.length > 0) {
      out.push({
        key: 'scielo-journals',
        label: 'SciELO revistas',
        codes: journals,
        title: 'Revistas científicas de las colecciones regionales de SciELO.'
      });
      journals.forEach((code) => used.add(code));
    }

    // Any other repository the API reports keeps working, with the label the API gave it.
    for (const [code, bucket] of present) {
      if (used.has(code)) continue;
      const info = sourceInfo(code, bucket.label);
      out.push({ key: code, label: info.short, codes: [code], title: info.description });
    }
    return out;
  }, [buckets, selected]);

  // A single repository is not a choice: no row until there is something to choose between.
  if (chips.length < 2 && selected.length === 0) return null;

  const isActive = (chip: SourceChip) => chip.codes.every((code) => selected.includes(code));
  const isExact = (chip: SourceChip) => isActive(chip) && selected.length === chip.codes.length;

  return (
    <div
      className="quickbar-scroll -mx-3 flex items-center gap-2 overflow-x-auto px-3 lg:mx-0 lg:basis-full lg:flex-wrap lg:overflow-visible lg:px-0"
      role="group"
      aria-label="Repositorio de origen"
    >
      <button type="button" className="chip shrink-0" aria-pressed={selected.length === 0} onClick={() => onSelect([])}>
        Todas
      </button>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className="chip shrink-0"
          aria-pressed={isActive(chip)}
          title={chip.title || undefined}
          onClick={() => onSelect(isExact(chip) ? [] : chip.codes)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
});
