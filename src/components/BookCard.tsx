import { memo } from 'react';
import { Bookmark, BookOpen, Eye } from 'lucide-react';
import type { ReadingProgress } from '../lib/readingProgress';
import {
  DOCTYPE_LABELS,
  LANGUAGE_LABELS,
  areaFillColor,
  areaTextColor,
  formatAuthors,
  getArea,
  langAttr
} from '../lib/publication';
import type { Publication } from '../types/publication';
import { PdfCoverThumbnail } from './PdfCoverThumbnail';

interface BookCardProps {
  publication: Publication;
  viewMode: 'grid' | 'list';
  enableLivePdfRender: boolean;
  isSaved: boolean;
  progress?: ReadingProgress;
  onSelect: (pub: Publication) => void;
  onReadPdf: (pub: Publication) => void;
  onQuickSave: (pub: Publication) => void;
}

export function progressPercent(progress: ReadingProgress | undefined, pageCount?: number): number | null {
  if (!progress) return null;
  const total = progress.totalPages ?? pageCount;
  if (!total || total < 1) return null;
  return Math.min(100, Math.max(1, Math.round((progress.page / total) * 100)));
}

function ProgressBar({ percent, className = '' }: { percent: number; className?: string }) {
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
  enableLivePdfRender,
  isSaved,
  progress,
  onSelect,
  onReadPdf,
  onQuickSave
}: BookCardProps) {
  const area = getArea(publication.oecdArea);
  const hasText = Boolean(publication.pdfUrl);
  const resuming = hasText && progress !== undefined && progress.page > 1;
  const percent = progressPercent(progress, publication.pageCount);

  const meta = [
    publication.country,
    LANGUAGE_LABELS[publication.language],
    publication.year ? String(publication.year) : null
  ]
    .filter(Boolean)
    .join(' · ');

  // At most one badge: a missing full text matters most, otherwise the type when it is not a book.
  const badge = !hasText ? 'Sin texto completo' : publication.docType !== 'book' ? DOCTYPE_LABELS[publication.docType] : null;

  const saveLabel = `${isSaved ? 'Quitar de estantería' : 'Guardar en estantería'}: ${publication.title}`;
  const primaryLabel = hasText ? (resuming ? 'Continuar' : 'Leer') : 'Ver ficha';

  const title = (
    <button
      type="button"
      className="card-link font-editorial text-[15px] font-semibold leading-snug group-hover:underline"
      lang={langAttr(publication)}
      onClick={() => onSelect(publication)}
    >
      {publication.title}
    </button>
  );

  const primary = (
    <button
      type="button"
      className="btn btn-primary btn-sm card-action"
      onClick={() => (hasText ? onReadPdf(publication) : onSelect(publication))}
      aria-label={`${primaryLabel}: ${publication.title}`}
    >
      {hasText ? <BookOpen className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
      <span>{primaryLabel}</span>
    </button>
  );

  const bookmark = (
    <button
      type="button"
      className="btn btn-quiet btn-icon btn-sm card-action"
      onClick={() => onQuickSave(publication)}
      aria-label={saveLabel}
      title={isSaved ? 'Quitar de estantería' : 'Guardar en estantería'}
    >
      <Bookmark
        className="h-4 w-4"
        fill={isSaved ? 'currentColor' : 'none'}
        style={{ color: isSaved ? 'var(--accent-primary)' : undefined }}
        aria-hidden="true"
      />
    </button>
  );

  if (viewMode === 'list') {
    return (
      <article className="book-card group flex items-center gap-3 overflow-hidden p-3 sm:p-3.5" data-view="list">
        <span
          className="h-12 w-1 shrink-0 self-center rounded-sm"
          style={{ backgroundColor: areaFillColor(area.id) }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 sm:line-clamp-1">{title}</h3>
          <p className="mt-0.5 line-clamp-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {formatAuthors(publication)}
          </p>
          <p className="mt-0.5 line-clamp-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {meta}
            {badge ? <span className="font-semibold"> · {badge}</span> : null}
            {progress && progress.page > 1 && percent === null ? ` · pág. ${progress.page}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {primary}
          {bookmark}
        </div>
        {percent !== null && progress && progress.page > 1 ? (
          <ProgressBar percent={percent} className="absolute inset-x-0 bottom-0" />
        ) : null}
      </article>
    );
  }

  return (
    <article className="book-card group flex flex-col overflow-hidden" data-view="grid">
      <div className="p-3 pb-0">
        <div className="relative">
          <PdfCoverThumbnail
            publication={publication}
            enableLivePdfRender={enableLivePdfRender}
            className="aspect-[3/4] w-full rounded-[3px]"
          />
          {badge ? (
            <span
              className="pointer-events-none absolute left-2 top-2 rounded border px-1.5 py-0.5 text-xs font-semibold"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)'
              }}
            >
              {badge}
            </span>
          ) : null}
          {percent !== null && progress && progress.page > 1 ? (
            <ProgressBar percent={percent} className="absolute inset-x-0 bottom-0" />
          ) : null}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-3.5 pt-3">
        <p className="micro truncate" style={{ color: areaTextColor(area.id) }}>
          {area.label}
        </p>
        <h3 className="mt-1 line-clamp-3">{title}</h3>
        <p className="mt-1 line-clamp-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {formatAuthors(publication)}
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {meta}
          {progress && progress.page > 1 && percent === null ? ` · pág. ${progress.page}` : ''}
        </p>

        <div className="min-h-3 flex-1" aria-hidden="true" />
        <div className="flex items-center gap-2 border-t pt-3" style={{ borderColor: 'var(--border-hairline)' }}>
          <div className="flex-1 [&>button]:w-full">{primary}</div>
          {bookmark}
        </div>
      </div>
    </article>
  );
});
