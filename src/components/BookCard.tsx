import { memo, type CSSProperties } from 'react';
import { Bookmark, BookOpen } from 'lucide-react';
import type { ReadingProgress } from '../lib/readingProgress';
import { DOCTYPE_LABELS, LANGUAGE_LABELS, formatAuthors, langAttr } from '../lib/publication';
import { sourceInfo } from '../lib/sources';
import type { Publication } from '../types/publication';
import { BookCover } from './BookCover';

interface BookCardProps {
  publication: Publication;
  viewMode: 'grid' | 'list';
  isSaved: boolean;
  progress?: ReadingProgress;
  /** First row(s) of the page: the cover is loaded eagerly. */
  priority?: boolean;
  /** Row/tile index used to stagger CSS entrance motion. */
  staggerIndex?: number;
  onSelect: (pub: Publication) => void;
  onQuickSave: (pub: Publication) => void;
}

/**
 * `sizes` for the 320/640 WebP renditions. Each term is the real cover width at that breakpoint
 * (page gutter, 0.5 rem column gap and the tile's own 0.25 rem padding included), so a 2x phone
 * gets the 320 file and anything denser gets the 640 one. Keep in sync with GRID_CLASS.
 */
export const GRID_COVER_SIZES =
  '(min-width: 1536px) 14rem, (min-width: 1280px) calc(20vw - 1.5rem), (min-width: 1024px) calc(25vw - 1.6rem), (min-width: 640px) calc(33.3vw - 1.9rem), calc(50vw - 1.75rem)';
const LIST_COVER_SIZES = '56px';

export function progressPercent(progress: ReadingProgress | undefined, pageCount?: number): number | null {
  if (!progress) return null;
  const total = progress.totalPages ?? pageCount;
  if (!total || total < 1) return null;
  return Math.min(100, Math.max(1, Math.round((progress.page / total) * 100)));
}

export function ProgressBar({ percent, className = '' }: { percent: number; className?: string }) {
  return (
    <div
      className={`progress-track ${className}`}
      role="progressbar"
      aria-label="Progreso de lectura"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

export const BookCard = memo(function BookCard({
  publication,
  viewMode,
  isSaved,
  progress,
  priority = false,
  staggerIndex = 0,
  onSelect,
  onQuickSave
}: BookCardProps) {
  const staggerStyle = { '--stagger-i': staggerIndex } as CSSProperties;
  const hasText = Boolean(publication.pdfUrl);
  const resuming = hasText && progress !== undefined && progress.page > 1;
  const percent = resuming ? progressPercent(progress, publication.pageCount) : null;
  const source = sourceInfo(publication.collectionCode, publication.collection);
  const isList = viewMode === 'list';

  // año · idioma (the type is only worth a word when it is not a book)
  const meta = [
    publication.docType !== 'book' ? DOCTYPE_LABELS[publication.docType] : null,
    publication.year ? String(publication.year) : null,
    LANGUAGE_LABELS[publication.language]
  ]
    .filter(Boolean)
    .join(' · ');

  const textState = resuming ? 'resume' : hasText ? 'full' : 'none';
  const textLabel = resuming ? `Continuar · pág. ${progress.page}` : hasText ? 'Texto completo' : 'Solo ficha';

  const title = (
    <button type="button" className="card-link" lang={langAttr(publication)} onClick={() => onSelect(publication)}>
      {publication.title}
    </button>
  );

  const bookmarkProps = {
    type: 'button' as const,
    onClick: () => onQuickSave(publication),
    'aria-pressed': isSaved,
    'aria-label': `Guardar en estantería: ${publication.title}`,
    title: isSaved ? 'Quitar de la estantería' : 'Guardar en estantería'
  };
  const bookmarkIcon = (
    <Bookmark className="h-4 w-4" fill={isSaved ? 'currentColor' : 'none'} aria-hidden="true" />
  );

  const textIndicator = (
    <p className="tile-text" data-state={textState}>
      {hasText ? <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
      <span>{textLabel}</span>
    </p>
  );

  if (isList) {
    return (
      <article className="book-row group" data-view="list" style={staggerStyle}>
        <div className="cover-slot w-14 shrink-0">
          <BookCover publication={publication} variant="list" sizes={LIST_COVER_SIZES} priority={priority} />
          {percent !== null ? <ProgressBar percent={percent} className="cover-progress" /> : null}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="tile-title">{title}</h3>
          <p className="tile-author mt-0.5">{formatAuthors(publication)}</p>
          <p className="tile-meta mt-0.5">
            {source.short} · {meta}
          </p>
          <div className="mt-1">{textIndicator}</div>
        </div>
        <button {...bookmarkProps} className="btn btn-ghost btn-icon card-action shrink-0">
          <Bookmark
            className="h-5 w-5"
            fill={isSaved ? 'currentColor' : 'none'}
            style={{ color: isSaved ? 'var(--accent-primary)' : undefined }}
            aria-hidden="true"
          />
        </button>
      </article>
    );
  }

  return (
    <article className="book-tile group" data-view="grid" style={staggerStyle}>
      <div className="cover-slot">
        <BookCover publication={publication} variant="grid" sizes={GRID_COVER_SIZES} priority={priority} />
        {percent !== null ? <ProgressBar percent={percent} className="cover-progress" /> : null}
      </div>

      <div className="min-w-0">
        <h3 className="tile-title">{title}</h3>
        <p className="tile-author mt-1">{formatAuthors(publication)}</p>
        <p className="tile-meta mt-0.5">{meta}</p>
        <div className="mt-1.5">{textIndicator}</div>
      </div>

      {/* After the text in DOM order (title first for keyboard and screen readers), pinned to the cover corner by CSS */}
      <button {...bookmarkProps} className="cover-bookmark card-action">
        {bookmarkIcon}
      </button>
    </article>
  );
});
