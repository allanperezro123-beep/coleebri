import { memo, useCallback, useMemo, useState } from 'react';
import { planCover, type CoverVariant } from '../lib/cover';
import type { Publication } from '../types/publication';
import { GeneratedCover } from './GeneratedCover';

interface BookCoverProps {
  publication: Publication;
  /** Rendered width hint for the browser (`sizes`), matched to the layout that hosts the cover. */
  sizes: string;
  variant?: CoverVariant;
  /** Above-the-fold covers: loaded eagerly with high priority (protects LCP). */
  priority?: boolean;
  /** Describe the cover to assistive tech (only when the title is not already next to it). */
  labelled?: boolean;
  className?: string;
}

type Stage = 'local' | 'remote' | 'generated';

function firstStage(hasLocal: boolean, hasRemote: boolean): Stage {
  if (hasLocal) return 'local';
  return hasRemote ? 'remote' : 'generated';
}

/**
 * A book cover in a fixed 2:3 frame (no layout shift). Chain: static WebP renditions →
 * trusted remote raster → typographic cover. PDF page 1 is deliberately NOT rendered here:
 * the PDFs weigh 5-10 MB and are fetched without range support.
 */
export const BookCover = memo(function BookCover({
  publication,
  sizes,
  variant = 'grid',
  priority = false,
  labelled = false,
  className = ''
}: BookCoverProps) {
  // `key` makes React reset the load state whenever the work changes.
  return (
    <CoverFrame
      key={publication.id}
      publication={publication}
      sizes={sizes}
      variant={variant}
      priority={priority}
      labelled={labelled}
      className={className}
    />
  );
});

function CoverFrame({ publication, sizes, variant = 'grid', priority, labelled, className = '' }: BookCoverProps) {
  const plan = useMemo(
    () => planCover(publication, variant),
    // only the fields the plan reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publication.id, publication.coverUrl, variant]
  );
  const [stage, setStage] = useState<Stage>(() => firstStage(Boolean(plan.local), Boolean(plan.remote)));
  const [loaded, setLoaded] = useState(false);

  const handleError = useCallback(() => {
    setLoaded(false);
    setStage((current) => (current === 'local' && plan.remote ? 'remote' : 'generated'));
  }, [plan.remote]);

  // Images that were already cached can finish before React attaches `onLoad`.
  const imageRef = useCallback((img: HTMLImageElement | null) => {
    if (img && img.complete && img.naturalWidth > 0) setLoaded(true);
  }, []);

  const imageProps = {
    alt: labelled ? `Portada de ${publication.title}` : '',
    width: 320,
    height: 480,
    decoding: 'async' as const,
    loading: priority ? ('eager' as const) : ('lazy' as const),
    fetchPriority: priority ? ('high' as const) : ('auto' as const),
    onLoad: () => setLoaded(true),
    onError: handleError,
    ref: imageRef,
    className: 'cover-img',
    'data-loaded': loaded ? 'true' : 'false'
  };

  return (
    <div
      className={`cover ${className}`}
      data-variant={variant}
      data-stage={stage}
      role={labelled && stage === 'generated' ? 'img' : undefined}
      aria-label={labelled && stage === 'generated' ? `Portada de ${publication.title}` : undefined}
    >
      {stage === 'local' && plan.local ? (
        <img {...imageProps} src={plan.local.src} srcSet={plan.local.srcSet} sizes={sizes} />
      ) : null}
      {stage === 'remote' && plan.remote ? <img {...imageProps} src={plan.remote} /> : null}
      {stage === 'generated' ? <GeneratedCover publication={publication} /> : null}
    </div>
  );
}
