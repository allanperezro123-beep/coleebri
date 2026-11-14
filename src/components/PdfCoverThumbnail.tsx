import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import { loadPdfjs, openPdfDocument } from '../lib/pdfLoader';
import { buildCoverProxyUrl, buildPdfProxyUrl, pdfThumbnailQueue } from '../lib/pdfWorker';
import { safeExternalUrl, trustedContentUrl } from '../lib/safeUrl';
import { OECD_AREA_MAP } from '../lib/taxonomy';
import type { OecdAreaDefinition, Publication } from '../types/publication';

interface PdfCoverThumbnailProps {
  publication: Publication;
  enableLivePdfRender: boolean;
  className?: string;
}

const RASTER_EXTENSION = /\.(?:jpe?g|png|webp|gif|avif)$/i;
const COVER_HOST = 'books.scielo.org';
/** Cards are ~3:4; these are only the intrinsic hints that reserve layout (CSS sizes the image). */
const COVER_WIDTH = 300;
const COVER_HEIGHT = 400;
/** Start loading when the card is within this distance of the viewport. */
const NEAR_VIEWPORT_MARGIN = '300px';

/**
 * Where to load a real cover from, if there is one.
 * - https raster image on books.scielo.org: loaded directly (the CSP allows exactly that host);
 * - any other trusted academic host: through the same-origin proxy (raster images only);
 * - anything else: no cover.
 */
function resolveCoverSrc(coverUrl: string | undefined): string | undefined {
  const safe = safeExternalUrl(coverUrl);
  if (!safe) return undefined;
  try {
    const url = new URL(safe);
    if (url.hostname.toLowerCase() === COVER_HOST && RASTER_EXTENSION.test(url.pathname)) {
      return safe;
    }
  } catch {
    return undefined;
  }
  const trusted = trustedContentUrl(coverUrl);
  return trusted ? buildCoverProxyUrl(trusted) : undefined;
}

function resolveArea(publication: Publication): OecdAreaDefinition {
  const map = OECD_AREA_MAP as Partial<Record<string, OecdAreaDefinition>>;
  return map[publication.oecdArea] ?? OECD_AREA_MAP['social-sciences'];
}

export function PdfCoverThumbnail({
  publication,
  enableLivePdfRender,
  className = ''
}: PdfCoverThumbnailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const [pdfState, setPdfState] = useState<'idle' | 'rendered' | 'failed'>('idle');

  const areaDef = resolveArea(publication);
  const coverSrc = useMemo(() => resolveCoverSrc(publication.coverUrl), [publication.coverUrl]);
  const pdfSource = useMemo(() => safeExternalUrl(publication.pdfUrl), [publication.pdfUrl]);

  const showCover = Boolean(coverSrc) && !coverFailed;

  // 1) Lazy: nothing (not even pdf.js) is touched until the card is near the viewport.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: NEAR_VIEWPORT_MARGIN }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 2) Render page 1 only when there is no usable cover image.
  const shouldRenderPdf =
    near &&
    !showCover &&
    pdfState === 'idle' &&
    Boolean(pdfSource) &&
    (enableLivePdfRender || publication.docType === 'book');

  useEffect(() => {
    if (!shouldRenderPdf || !pdfSource) return;
    const controller = new AbortController();
    const state: { loadingTask: PDFDocumentLoadingTask | null; render: RenderTask | null } = {
      loadingTask: null,
      render: null
    };

    void pdfThumbnailQueue
      .enqueue(async () => {
        if (controller.signal.aborted) return;
        const pdfjs = await loadPdfjs();
        if (controller.signal.aborted) return;

        const loadingTask = openPdfDocument(pdfjs, buildPdfProxyUrl(pdfSource));
        state.loadingTask = loadingTask;
        try {
          const doc = await loadingTask.promise;
          if (controller.signal.aborted) return;
          const page = await doc.getPage(1);
          const canvas = canvasRef.current;
          if (controller.signal.aborted || !canvas) return;

          // Crisp on retina, but never more than 2x and never wider than the card needs.
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const cssWidth = containerRef.current?.clientWidth || 220;
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(3, (cssWidth * dpr) / base.width);
          const viewport = page.getViewport({ scale });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Canvas 2D context unavailable');

          state.render = page.render({
            canvasContext: ctx,
            canvas,
            viewport,
            background: '#FBF9F5'
          });
          await state.render.promise;
          if (!controller.signal.aborted) setPdfState('rendered');
        } finally {
          await loadingTask.destroy().catch(() => undefined);
          state.loadingTask = null;
        }
      }, controller.signal)
      .catch(() => {
        if (!controller.signal.aborted) setPdfState('failed');
      });

    return () => {
      controller.abort();
      state.render?.cancel();
      void state.loadingTask?.destroy().catch(() => undefined);
    };
  }, [shouldRenderPdf, pdfSource]);

  const pdfActive = pdfState === 'rendered';
  const showTypographic = !showCover && !pdfActive;

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden border ${className}`}
      style={{
        borderColor: 'var(--border-hairline)',
        backgroundColor: 'var(--bg-surface)'
      }}
    >
      {/* 1. Real cover image (decorative: the title is already visible next to it) */}
      {showCover && coverSrc && (
        <img
          src={coverSrc}
          alt=""
          width={COVER_WIDTH}
          height={COVER_HEIGHT}
          loading="lazy"
          decoding="async"
          onError={() => setCoverFailed(true)}
          className="absolute inset-0 h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-500 motion-safe:group-hover:scale-[1.03]"
        />
      )}

      {/* 2. Page 1 of the PDF, rendered lazily and only when there is no cover */}
      {!showCover && Boolean(pdfSource) && (near || pdfActive) && pdfState !== 'failed' && (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={`h-full w-full object-cover motion-safe:transition-opacity motion-safe:duration-300 ${
            pdfActive ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}

      {/* 3. Editorial typographic cover (always safe) */}
      {showTypographic && (
        <div
          className="absolute inset-0 flex flex-col justify-between p-3.5"
          style={{
            background: `linear-gradient(155deg, ${areaDef.accent}18 0%, var(--bg-surface) 58%, ${areaDef.accent}10 100%)`,
            borderLeft: `4px solid ${areaDef.accent}`
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span
              className="truncate text-[10px] font-semibold uppercase tracking-widest"
              style={{ color: areaDef.accent }}
            >
              {publication.publisher}
            </span>
            {publication.year && (
              <span className="font-code text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                {publication.year}
              </span>
            )}
          </div>

          <div className="my-auto py-2">
            <div
              className="mb-2 h-[1px] w-8"
              style={{ backgroundColor: areaDef.accent, opacity: 0.6 }}
            />
            <p className="font-editorial line-clamp-4 text-sm font-semibold leading-snug">
              {publication.title}
            </p>
          </div>

          <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--text-secondary)' }}>
            <span className="truncate">{publication.authors?.[0] || publication.collection}</span>
            <span className="font-code uppercase">{publication.language}</span>
          </div>
        </div>
      )}
    </div>
  );
}
