import { memo } from 'react';
import { BookOpen } from 'lucide-react';
import type { ReadingProgress } from '../lib/readingProgress';
import { areaFillColor, formatAuthors, langAttr } from '../lib/publication';
import type { Publication } from '../types/publication';
import { progressPercent } from './BookCard';

export interface ContinueEntry {
  publication: Publication;
  progress: ReadingProgress;
}

interface ContinueReadingProps {
  entries: ContinueEntry[];
  onRead: (pub: Publication) => void;
  onSelect: (pub: Publication) => void;
}

/** A single quiet row of the books the visitor has started, most recent first. */
export const ContinueReading = memo(function ContinueReading({ entries, onRead, onSelect }: ContinueReadingProps) {
  if (entries.length === 0) return null;
  return (
    <section className="mb-6" aria-labelledby="continue-reading-title">
      <h2 id="continue-reading-title" className="font-editorial mb-2 text-lg font-semibold">
        Continuar leyendo
      </h2>
      <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {entries.map(({ publication, progress }) => {
          const percent = progressPercent(progress, publication.pageCount);
          return (
            <li
              key={publication.id}
              className="book-card relative flex w-64 shrink-0 snap-start flex-col gap-2 p-3"
              style={{ borderLeft: `3px solid ${areaFillColor(publication.oecdArea)}`, contentVisibility: 'visible' }}
            >
              <button
                type="button"
                className="card-link font-editorial line-clamp-2 text-[15px] font-semibold leading-snug"
                lang={langAttr(publication)}
                onClick={() => onSelect(publication)}
              >
                {publication.title}
              </button>
              <p className="line-clamp-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                {formatAuthors(publication, 2)}
              </p>
              <div className="mt-auto flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  {percent !== null ? (
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-label="Progreso de lectura"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                    >
                      <div className="progress-fill" style={{ width: `${percent}%` }} />
                    </div>
                  ) : null}
                  <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {percent !== null ? `${percent} % · ` : ''}página {progress.page}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm card-action"
                  onClick={() => onRead(publication)}
                  aria-label={`Continuar leyendo: ${publication.title}`}
                >
                  <BookOpen className="h-4 w-4" aria-hidden="true" />
                  <span>Continuar</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
});
