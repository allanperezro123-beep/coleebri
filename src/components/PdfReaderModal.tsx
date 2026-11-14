import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent
} from 'react';
import {
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Ellipsis,
  ExternalLink,
  FileText,
  Loader2,
  Maximize,
  Maximize2,
  Minimize,
  Moon,
  PanelLeft,
  RefreshCw,
  Search,
  Sun,
  TriangleAlert,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import '../styles/reader.css';
import { ReaderLoadingView } from './ReaderLoadingView';
import { loadPdfjs, openPdfDocument, type PdfjsModule } from '../lib/pdfLoader';
import {
  buildPdfProxyUrl,
  classifyPdfError,
  ConcurrencyQueue,
  isAbortError,
  pdfErrorInfo,
  type PdfErrorInfo
} from '../lib/pdfWorker';
import { getReadingProgress, saveReadingProgress } from '../lib/readingProgress';
import { extractReflowText, type ReflowBlock } from '../lib/reflow';
import { safeExternalUrl } from '../lib/safeUrl';
import type { Publication } from '../types/publication';

interface PdfReaderModalProps {
  publication: Publication;
  initialPage?: number;
  onClose: () => void;
  onPagePersist?: (page: number) => void;
}

/* ------------------------------------------------------------------ */
/* Constants & small helpers                                           */
/* ------------------------------------------------------------------ */

const MQ_COMPACT = '(max-width: 1099.98px)';
const MQ_PHONE = '(max-width: 639.98px)';
const MQ_WIDE = '(min-width: 1024px)';

const MODE_KEY = 'coleebri:reader-mode:v1';
const FONT_KEY = 'coleebri:reflow-font:v1';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.15;
/** Fit-to-width never blows a page up beyond this on very wide screens. */
const FIT_MAX = 1.8;
/** Never allocate canvases beyond ~16 Mpx (iOS Safari silently fails above its limit). */
const MAX_CANVAS_PIXELS = 16_777_216;
/** Ivory paper instead of pdf.js' default pure white. */
const PAGE_BACKGROUND = '#FBF9F5';

const FONT_MIN = 14;
const FONT_MAX = 26;
const FONT_STEP = 2;
const FONT_DEFAULT = 18;

type ReaderMode = 'canvas' | 'fluid' | 'text';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; info: PdfErrorInfo };

type SearchStatus = 'idle' | 'running' | 'done' | 'stopped' | 'error';

interface SearchResult {
  page: number;
  count: number;
}

interface SearchState {
  status: SearchStatus;
  scanned: number;
  results: SearchResult[];
}

const IDLE_SEARCH: SearchState = { status: 'idle', scanned: 0, results: [] };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode / quota): the preference simply isn't remembered
  }
}

function readStoredMode(): ReaderMode {
  const stored = readStorage(MODE_KEY);
  if (stored === 'text') return 'text';
  if (stored === 'fluid' || stored === 'reflow') return 'fluid';
  return 'canvas';
}

function readStoredFont(): number {
  const raw = Number.parseInt(readStorage(FONT_KEY) ?? '', 10);
  return Number.isFinite(raw) ? clamp(raw, FONT_MIN, FONT_MAX) : FONT_DEFAULT;
}

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query]
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/* ---- accent / case folding (search) -------------------------------- */

/**
 * Folds case and diacritics ("Educación" -> "educacion") while remembering, for every folded
 * UTF-16 unit, the index it came from in the original string. That lets us highlight the
 * exact original characters of a folded match. (`\p{M}` = combining marks only, so unrelated
 * symbols such as `^` survive, unlike `\p{Diacritic}`.)
 */
function foldWithMap(input: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let origIdx = 0;
  for (const ch of input) {
    const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < f.length; k++) map.push(origIdx);
    folded += f;
    origIdx += ch.length;
  }
  map.push(input.length);
  return { folded, map };
}

function foldQuery(query: string): string {
  return foldWithMap(query.replace(/\s+/g, ' ').trim()).folded;
}

interface SearchItemLike {
  str: string;
  hasEOL?: boolean;
}

function isSearchItem(value: unknown): value is SearchItemLike {
  return typeof value === 'object' && value !== null && typeof (value as SearchItemLike).str === 'string';
}

/** Page text as one string; words hyphenated at a line end are re-joined. */
function itemsToSearchText(items: ReadonlyArray<unknown>): string {
  let out = '';
  for (const item of items) {
    if (!isSearchItem(item)) continue;
    let s = item.str;
    if (item.hasEOL) {
      s = /\p{L}[-‐­]$/u.test(s) ? s.slice(0, -1) : s + ' ';
    }
    out += s;
  }
  return out.replace(/\s+/g, ' ');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function clearHighlights(root: HTMLElement): void {
  for (const mark of root.querySelectorAll('mark.rd-match')) {
    const parent = mark.parentNode;
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
    parent?.normalize();
  }
}

/** Wraps every occurrence of `term` (accent/case-insensitive) inside the text-layer spans. */
function applyHighlights(root: HTMLElement, term: string): void {
  const needle = foldQuery(term);
  if (needle.length < 2) return;

  for (const span of root.querySelectorAll<HTMLElement>('.textLayer span')) {
    if (span.childElementCount > 0) continue;
    const raw = span.textContent ?? '';
    if (!raw) continue;
    const { folded, map } = foldWithMap(raw);
    let idx = folded.indexOf(needle);
    if (idx < 0) continue;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    while (idx >= 0) {
      const start = map[idx];
      const end = map[idx + needle.length] ?? raw.length;
      if (start > cursor) frag.append(raw.slice(cursor, start));
      const mark = document.createElement('mark');
      mark.className = 'rd-match';
      mark.textContent = raw.slice(start, end);
      frag.append(mark);
      cursor = end;
      idx = folded.indexOf(needle, idx + needle.length);
    }
    if (cursor < raw.length) frag.append(raw.slice(cursor));
    span.replaceChildren(frag);
  }
}

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/* ------------------------------------------------------------------ */
/* Shared PDF page bitmap & text-layer painting helpers                */
/* ------------------------------------------------------------------ */

interface CanvasBudget {
  maxDpr: number;
  maxPixels: number;
}

function getCanvasBudget(isCompact: boolean, isFluid: boolean): CanvasBudget {
  if (isCompact) {
    return {
      maxDpr: isFluid ? 1.5 : 1.75,
      maxPixels: isFluid ? 8_388_608 : 12_582_912
    };
  }
  return {
    maxDpr: 2,
    maxPixels: isFluid ? 12_582_912 : MAX_CANVAS_PIXELS
  };
}

function resolvePageScale(unscaledWidth: number, zoom: number | 'fit', availWidth: number): number {
  if (zoom === 'fit') {
    const safeWidth = Math.max(240, availWidth || unscaledWidth);
    return clamp(safeWidth / unscaledWidth, MIN_ZOOM, FIT_MAX);
  }
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

/**
 * Renders one PDF page into a scratch off-screen canvas and blits onto `targetCanvas`,
 * freeing the temporary bitmap immediately (critical for 3 GB iPhone X / XR memory limits).
 */
async function renderPdfBitmap(
  page: PDFPageProxy,
  scale: number,
  budget: CanvasBudget,
  targetCanvas: HTMLCanvasElement,
  isStale: () => boolean,
  onTask: (task: RenderTask | null) => void
): Promise<{ viewport: ReturnType<PDFPageProxy['getViewport']> } | null> {
  const viewport = page.getViewport({ scale });
  let outScale = Math.min(window.devicePixelRatio || 1, budget.maxDpr);
  const pixels = viewport.width * viewport.height * outScale * outScale;
  if (pixels > budget.maxPixels) {
    outScale = Math.max(0.5, Math.sqrt(budget.maxPixels / (viewport.width * viewport.height)));
  }

  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.floor(viewport.width * outScale));
  off.height = Math.max(1, Math.floor(viewport.height * outScale));
  const offCtx = off.getContext('2d');
  if (!offCtx) throw new Error('Canvas 2D context unavailable');

  const task = page.render({
    canvasContext: offCtx,
    canvas: off,
    viewport,
    transform: outScale === 1 ? undefined : [outScale, 0, 0, outScale, 0, 0],
    background: PAGE_BACKGROUND
  });
  onTask(task);
  try {
    await task.promise;
  } finally {
    onTask(null);
  }
  if (isStale()) {
    off.width = 0;
    return null;
  }

  targetCanvas.width = off.width;
  targetCanvas.height = off.height;
  targetCanvas.style.width = `${Math.floor(viewport.width)}px`;
  targetCanvas.style.height = `${Math.floor(viewport.height)}px`;
  targetCanvas.getContext('2d')?.drawImage(off, 0, 0);
  off.width = 0;
  return { viewport };
}

async function mountPdfTextLayer(
  page: PDFPageProxy,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  scale: number,
  host: HTMLElement,
  isStale: () => boolean,
  onTask: (task: { cancel: () => void } | null) => void
): Promise<boolean> {
  const pdfjs: PdfjsModule = await loadPdfjs();
  const textContent = await page.getTextContent();
  if (isStale()) return false;

  const layerEl = document.createElement('div');
  layerEl.className = 'textLayer';
  layerEl.style.setProperty('--scale-factor', String(scale));
  layerEl.style.setProperty('--total-scale-factor', String(scale));
  const textLayer = new pdfjs.TextLayer({
    textContentSource: textContent,
    container: layerEl,
    viewport
  });
  onTask(textLayer);
  try {
    await textLayer.render();
  } finally {
    onTask(null);
  }
  if (isStale()) return false;

  const endOfContent = document.createElement('div');
  endOfContent.className = 'endOfContent';
  layerEl.append(endOfContent);
  layerEl.addEventListener('pointerdown', () => {
    layerEl.classList.add('selecting');
    const release = () => {
      layerEl.classList.remove('selecting');
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', release);
    };
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
  });
  host.replaceChildren(layerEl);
  return true;
}

/* ------------------------------------------------------------------ */
/* Thumbnail tile (page rail)                                          */
/* ------------------------------------------------------------------ */

/** Rail thumbnails: at most 2 renders at a time. */
const railQueue = new ConcurrencyQueue(2);
const THUMB_CSS_WIDTH = 120;

interface ThumbnailTileProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  isActive: boolean;
  isMatch: boolean;
  onSelect: (page: number) => void;
}

const ThumbnailTile = memo(function ThumbnailTile({
  pdfDoc,
  pageNumber,
  isActive,
  isMatch,
  onSelect
}: ThumbnailTileProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const el = buttonRef.current;
    if (!el || rendered) return;
    const controller = new AbortController();
    let task: RenderTask | null = null;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        observer.disconnect();
        void railQueue
          .enqueue(async () => {
            if (controller.signal.aborted) return;
            const page = await pdfDoc.getPage(pageNumber);
            const canvas = canvasRef.current;
            if (controller.signal.aborted || !canvas) return;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: (THUMB_CSS_WIDTH * dpr) / base.width });
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            task = page.render({ canvasContext: ctx, canvas, viewport, background: PAGE_BACKGROUND });
            await task.promise;
            if (!controller.signal.aborted) setRendered(true);
          }, controller.signal)
          .catch(() => undefined); // cancelled / destroyed document: nothing to show
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);

    return () => {
      controller.abort();
      observer.disconnect();
      task?.cancel();
    };
  }, [pdfDoc, pageNumber, rendered]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className="rd-thumb"
      aria-label={`Ir a la página ${pageNumber}${isMatch ? ' (coincidencia de búsqueda)' : ''}`}
      aria-current={isActive ? 'page' : undefined}
      data-match={isMatch}
      onClick={() => onSelect(pageNumber)}
    >
      <span className="rd-thumb-frame">
        <canvas ref={canvasRef} aria-hidden="true" />
        {!rendered && <span className="rd-thumb-num">{pageNumber}</span>}
      </span>
      <span className="rd-thumb-caption">
        <span>p. {pageNumber}</span>
        {isMatch && <span className="rd-thumb-badge">coincide</span>}
      </span>
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Lectura fluida                                                      */
/* ------------------------------------------------------------------ */

type ReflowPageState = ReflowBlock[] | 'error' | undefined;

interface ReflowSectionProps {
  page: number;
  state: ReflowPageState;
  onRetry: (page: number) => void;
  onSwitchToOriginal: (page: number) => void;
}

const ReflowSection = memo(function ReflowSection({
  page,
  state,
  onRetry,
  onSwitchToOriginal
}: ReflowSectionProps) {
  const headingId = `rd-rf-${page}`;
  return (
    <section
      className="rd-reflow-page"
      data-reflow-page={page}
      aria-labelledby={headingId}
      aria-busy={state === undefined}
    >
      <h2 className="rd-reflow-mark" id={headingId}>
        Página {page}
      </h2>

      {state === undefined && (
        <p className="rd-reflow-sentinel">
          <Loader2 className="rd-spin" size={16} aria-hidden="true" />
          Cargando la página {page}…
        </p>
      )}

      {state === 'error' && (
        <div className="rd-reflow-note" role="alert">
          <p>No se pudo leer el texto de esta página.</p>
          <button type="button" className="rd-btn" onClick={() => onRetry(page)}>
            <RefreshCw size={16} />
            Reintentar
          </button>
        </div>
      )}

      {Array.isArray(state) && state.length === 0 && (
        <div className="rd-reflow-note">
          <p>Esta página es una imagen escaneada; cambia a vista original.</p>
          <button type="button" className="rd-btn" onClick={() => onSwitchToOriginal(page)}>
            Ver vista original
          </button>
        </div>
      )}

      {Array.isArray(state) &&
        state.map((block, i) => {
          if (block.type === 'heading') {
            const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1];
            return (
              <Tag key={i} className="rd-reflow-h" data-level={block.level}>
                {block.text}
              </Tag>
            );
          }
          return <p key={i}>{block.text}</p>;
        })}
    </section>
  );
});

interface ReflowViewProps {
  pdfDoc: PDFDocumentProxy;
  numPages: number;
  jumpTo: { page: number; nonce: number };
  scrollRef: RefObject<HTMLDivElement | null>;
  cache: Map<number, ReflowBlock[]>;
  lang?: string;
  onVisiblePage: (page: number) => void;
  onSwitchToOriginal: (page: number) => void;
}

/**
 * Continuous, single-column reading view. Pages are extracted progressively (at most two at a
 * time) as a sentinel nears the viewport. All text is rendered through React text nodes.
 */
const ReflowView = memo(function ReflowView({
  pdfDoc,
  numPages,
  jumpTo,
  scrollRef,
  cache,
  lang,
  onVisiblePage,
  onSwitchToOriginal
}: ReflowViewProps) {
  const [first, setFirst] = useState(jumpTo.page);
  const [upTo, setUpTo] = useState(jumpTo.page);
  const [pages, setPages] = useState<Record<number, ReflowPageState>>({});
  const [sentinelVisible, setSentinelVisible] = useState(false);
  const [earlierBusy, setEarlierBusy] = useState(false);

  const limiter = useState(() => new ConcurrencyQueue(2))[0];
  const controllerRef = useRef<AbortController | null>(null);
  const inflightRef = useRef(new Set<number>());
  const sentinelRef = useRef<HTMLDivElement>(null);
  const handledNonceRef = useRef(jumpTo.nonce);
  const pendingScrollRef = useRef<{ height: number; top: number } | null>(null);

  const hasMore = upTo < numPages;

  // Lifetime of every extraction started by this view.
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    const inflight = inflightRef.current;
    return () => {
      controller.abort();
      inflight.clear();
    };
  }, []);

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [scrollRef]);

  // Extract every page in [first, upTo] that we do not have yet.
  useEffect(() => {
    const signal = controllerRef.current?.signal;
    if (!signal) return;
    for (let p = first; p <= upTo; p++) {
      if (pages[p] !== undefined || inflightRef.current.has(p)) continue;
      const cached = cache.get(p);
      if (cached) {
        setPages((prev) => ({ ...prev, [p]: cached }));
        continue;
      }
      inflightRef.current.add(p);
      limiter
        .enqueue(() => extractReflowText(pdfDoc, p, signal), signal)
        .then((blocks) => {
          cache.set(p, blocks);
          setPages((prev) => ({ ...prev, [p]: blocks }));
        })
        .catch((err: unknown) => {
          if (!isAbortError(err)) setPages((prev) => ({ ...prev, [p]: 'error' }));
        })
        .finally(() => {
          inflightRef.current.delete(p);
        });
    }
  }, [first, upTo, pages, pdfDoc, cache, limiter]);

  // Infinite scroll: a sentinel below the last page asks for more when it nears the viewport.
  useEffect(() => {
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!hasMore || !el || !root) {
      setSentinelVisible(false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setSentinelVisible(Boolean(entries[entries.length - 1]?.isIntersecting)),
      { root, rootMargin: '0px 0px 900px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, scrollRef]);

  // Only grow the window once everything already in it has finished loading.
  useEffect(() => {
    if (!sentinelVisible || !hasMore) return;
    for (let p = first; p <= upTo; p++) if (pages[p] === undefined) return;
    setUpTo((u) => Math.min(numPages, u + 2));
  }, [sentinelVisible, hasMore, first, upTo, pages, numPages]);

  // Report which page the reader is looking at (band at the top of the scroll area).
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.reflowPage);
          if (!Number.isFinite(page)) continue;
          if (entry.isIntersecting) visible.add(page);
          else visible.delete(page);
        }
        if (visible.size > 0) onVisiblePage(Math.max(...visible));
      },
      { root, rootMargin: '0px 0px -75% 0px', threshold: 0 }
    );
    root.querySelectorAll('[data-reflow-page]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [first, upTo, scrollRef, onVisiblePage]);

  // Programmatic jumps (page buttons, search, thumbnails).
  useEffect(() => {
    if (handledNonceRef.current === jumpTo.nonce) return;
    handledNonceRef.current = jumpTo.nonce;
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(`[data-reflow-page="${jumpTo.page}"]`);
    if (target) {
      root.scrollTo({ top: Math.max(0, target.offsetTop - 8) });
      return;
    }
    // Outside the loaded window: restart the window at the requested page.
    setFirst(jumpTo.page);
    setUpTo(jumpTo.page);
    root.scrollTo({ top: 0 });
  }, [jumpTo, scrollRef]);

  // Keep the reading position when earlier pages are inserted above it.
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const root = scrollRef.current;
    if (!pending || !root) return;
    pendingScrollRef.current = null;
    root.scrollTop = pending.top + (root.scrollHeight - pending.height);
  }, [first, scrollRef]);

  const loadEarlier = useCallback(async () => {
    const signal = controllerRef.current?.signal;
    const root = scrollRef.current;
    if (!signal || !root || earlierBusy || first <= 1) return;
    setEarlierBusy(true);
    const start = Math.max(1, first - 2);
    try {
      const loaded: Record<number, ReflowPageState> = {};
      await Promise.all(
        range(start, first - 1).map(async (p) => {
          const cached = cache.get(p);
          const blocks =
            cached ?? (await limiter.enqueue(() => extractReflowText(pdfDoc, p, signal), signal));
          cache.set(p, blocks);
          loaded[p] = blocks;
        })
      );
      pendingScrollRef.current = { height: root.scrollHeight, top: root.scrollTop };
      setPages((prev) => ({ ...prev, ...loaded }));
      setFirst(start);
    } catch (err) {
      if (!isAbortError(err)) {
        // Leave the button in place so the reader can try again.
      }
    } finally {
      setEarlierBusy(false);
    }
  }, [cache, earlierBusy, first, limiter, pdfDoc, scrollRef]);

  const retryPage = useCallback((page: number) => {
    setPages((prev) => {
      const next = { ...prev };
      delete next[page];
      return next;
    });
  }, []);

  return (
    <div className="rd-reflow" lang={lang}>
      {first > 1 && (
        <div className="rd-reflow-more">
          <button type="button" className="rd-btn" onClick={() => void loadEarlier()} disabled={earlierBusy}>
            {earlierBusy ? <Loader2 className="rd-spin" size={16} /> : <ChevronUp size={16} />}
            Cargar páginas anteriores
          </button>
        </div>
      )}

      {range(first, upTo).map((page) => (
        <ReflowSection
          key={page}
          page={page}
          state={pages[page]}
          onRetry={retryPage}
          onSwitchToOriginal={onSwitchToOriginal}
        />
      ))}

      {hasMore ? (
        <div ref={sentinelRef} className="rd-reflow-sentinel" aria-hidden="true">
          <Loader2 className="rd-spin" size={16} />
        </div>
      ) : (
        <p className="rd-reflow-end">Fin del documento</p>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Lectura fluida (continuous PDF canvas stream)                       */
/* ------------------------------------------------------------------ */

interface PageSize {
  width: number;
  height: number;
}

interface FluidPageTileProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  numPages: number;
  baseSize: PageSize;
  zoom: number | 'fit';
  availWidth: number;
  isCompact: boolean;
  inWindow: boolean;
  night: boolean;
  activeTerm: string;
  renderNonce: number;
  queue: ConcurrencyQueue;
  onSizeKnown: (page: number, size: PageSize) => void;
}

const FluidPageTile = memo(function FluidPageTile({
  pdfDoc,
  pageNumber,
  numPages,
  baseSize,
  zoom,
  availWidth,
  isCompact,
  inWindow,
  night,
  activeTerm,
  renderNonce,
  queue,
  onSizeKnown
}: FluidPageTileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const activeTermRef = useRef(activeTerm);
  activeTermRef.current = activeTerm;

  const [painted, setPainted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [localRetry, setLocalRetry] = useState(0);

  const scale = resolvePageScale(baseSize.width, zoom, availWidth);
  const cssWidth = Math.max(120, Math.floor(baseSize.width * scale));
  const cssHeight = Math.max(160, Math.floor(baseSize.height * scale));

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!inWindow || (zoom === 'fit' && availWidth <= 0)) {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      host?.replaceChildren();
      setPainted(false);
      setFailed(false);
      return;
    }

    const controller = new AbortController();
    let renderTask: RenderTask | null = null;
    let textTask: { cancel: () => void } | null = null;
    let stale = false;
    const isStale = () => stale || controller.signal.aborted;

    setFailed(false);

    void queue
      .enqueue(async () => {
        if (isStale()) return;
        const page = await pdfDoc.getPage(pageNumber);
        if (isStale()) return;

        const unscaled = page.getViewport({ scale: 1 });
        if (Math.abs(unscaled.width - baseSize.width) > 1.5 || Math.abs(unscaled.height - baseSize.height) > 1.5) {
          onSizeKnown(pageNumber, { width: unscaled.width, height: unscaled.height });
        }

        const effectiveScale = resolvePageScale(unscaled.width, zoom, availWidth);
        const curCanvas = canvasRef.current;
        const curHost = hostRef.current;
        if (!curCanvas || !curHost) return;

        const paintedResult = await renderPdfBitmap(
          page,
          effectiveScale,
          getCanvasBudget(isCompact, true),
          curCanvas,
          isStale,
          (t) => {
            renderTask = t;
          }
        );
        if (!paintedResult || isStale()) return;
        curHost.replaceChildren();
        setPainted(true);

        const textOk = await mountPdfTextLayer(
          page,
          paintedResult.viewport,
          effectiveScale,
          curHost,
          isStale,
          (t) => {
            textTask = t;
          }
        );
        if (textOk && !isStale() && activeTermRef.current) {
          applyHighlights(curHost, activeTermRef.current);
        }
      }, controller.signal)
      .catch((err: unknown) => {
        const name = (err as { name?: string } | null)?.name;
        if (name !== 'RenderingCancelledException' && name !== 'AbortException' && !isStale()) {
          setFailed(true);
        }
      });

    return () => {
      stale = true;
      controller.abort();
      renderTask?.cancel();
      textTask?.cancel();
    };
  }, [
    inWindow,
    pdfDoc,
    pageNumber,
    zoom,
    availWidth,
    isCompact,
    renderNonce,
    localRetry,
    queue,
    baseSize.width,
    baseSize.height,
    onSizeKnown
  ]);

  // Keep search highlights synced without repainting canvases when search term changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !inWindow) return;
    clearHighlights(host);
    if (activeTerm) applyHighlights(host, activeTerm);
  }, [activeTerm, inWindow, painted]);

  return (
    <article
      className="rd-fluid-page"
      data-fluid-page={pageNumber}
      aria-label={`Página ${pageNumber} de ${numPages}`}
    >
      <div
        className="rd-fluid-sheet"
        data-night={night}
        style={{ width: `${cssWidth}px`, height: `${cssHeight}px` }}
      >
        <canvas
          ref={canvasRef}
          className={painted ? 'rd-canvas rd-canvas--painted' : 'rd-canvas'}
          data-night={night}
          aria-hidden="true"
        />
        <div ref={hostRef} className="rd-textlayer-host" />
        {inWindow && !painted && !failed && (
          <div className="rd-fluid-placeholder" aria-hidden="true">
            <Loader2 className="rd-spin rd-state-icon--busy" size={20} />
            <span>Pág. {pageNumber}</span>
          </div>
        )}
        {failed && (
          <div className="rd-stage-overlay" style={{ pointerEvents: 'auto' }}>
            <div className="rd-state" role="alert">
              <p className="rd-state-text">No se pudo dibujar la página {pageNumber}.</p>
              <div className="rd-state-actions">
                <button type="button" className="rd-btn rd-btn--primary" onClick={() => setLocalRetry((n) => n + 1)}>
                  <RefreshCw size={16} />
                  Reintentar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <span className="rd-fluid-badge" aria-hidden="true">
        {pageNumber} / {numPages}
      </span>
    </article>
  );
});

interface FluidPdfViewProps {
  pdfDoc: PDFDocumentProxy;
  numPages: number;
  defaultPageSize: PageSize;
  jumpTo: { page: number; nonce: number };
  scrollRef: RefObject<HTMLDivElement | null>;
  zoom: number | 'fit';
  availWidth: number;
  isCompact: boolean;
  night: boolean;
  activeTerm: string;
  renderNonce: number;
  onScaleChange: (scale: number) => void;
  onVisiblePage: (page: number) => void;
}

const FluidPdfView = memo(function FluidPdfView({
  pdfDoc,
  numPages,
  defaultPageSize,
  jumpTo,
  scrollRef,
  zoom,
  availWidth,
  isCompact,
  night,
  activeTerm,
  renderNonce,
  onScaleChange,
  onVisiblePage
}: FluidPdfViewProps) {
  const [sizeOverrides, setSizeOverrides] = useState<Record<number, PageSize>>({});
  const [windowPages, setWindowPages] = useState<Set<number>>(() => {
    const initial = new Set<number>();
    const start = clamp(jumpTo.page, 1, Math.max(1, numPages));
    for (let p = Math.max(1, start - 1); p <= Math.min(numPages, start + 2); p++) {
      initial.add(p);
    }
    return initial;
  });

  const queue = useMemo(() => new ConcurrencyQueue(isCompact ? 2 : 3), [isCompact]);
  const handledNonceRef = useRef(-1);
  const suppressSyncUntilRef = useRef(0);

  const handleSizeKnown = useCallback((page: number, size: PageSize) => {
    setSizeOverrides((prev) => {
      const existing = prev[page];
      if (existing && Math.abs(existing.width - size.width) < 1 && Math.abs(existing.height - size.height) < 1) {
        return prev;
      }
      return { ...prev, [page]: size };
    });
  }, []);

  // Keep toolbar zoom indicator synchronized in fluid mode too.
  useEffect(() => {
    if (zoom === 'fit' && availWidth <= 0) return;
    onScaleChange(resolvePageScale(defaultPageSize.width, zoom, availWidth));
  }, [zoom, availWidth, defaultPageSize.width, onScaleChange]);

  // Programmatic scroll on mount (if entering at page > 1) and explicit jumps (buttons/rail/search).
  useLayoutEffect(() => {
    if (handledNonceRef.current === jumpTo.nonce) return;
    handledNonceRef.current = jumpTo.nonce;
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(`[data-fluid-page="${jumpTo.page}"]`);
    if (!target) return;

    suppressSyncUntilRef.current = performance.now() + 300;
    setWindowPages((prev) => {
      const next = new Set(prev);
      for (let p = Math.max(1, jumpTo.page - 1); p <= Math.min(numPages, jumpTo.page + 2); p++) {
        next.add(p);
      }
      return next;
    });
    const top = Math.max(0, target.offsetTop - 8);
    root.scrollTo({ top, behavior: 'auto' });
  }, [jumpTo, numPages, scrollRef]);

  // 1) Render / evict canvas bitmaps dynamically around the visible scrollport.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const nearMargin = isCompact ? '480px 0px' : '820px 0px';
    const currentSet = new Set<number>();

    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const p = Number((entry.target as HTMLElement).dataset.fluidPage);
          if (!Number.isFinite(p)) continue;
          if (entry.isIntersecting) {
            if (!currentSet.has(p)) {
              currentSet.add(p);
              changed = true;
            }
          } else if (currentSet.delete(p)) {
            changed = true;
          }
        }
        if (changed) setWindowPages(new Set(currentSet));
      },
      { root, rootMargin: nearMargin, threshold: 0 }
    );

    root.querySelectorAll('[data-fluid-page]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [numPages, isCompact, scrollRef]);

  // 2) Track which page fills the primary reading viewport without flicker.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const visibleRatios = new Map<number, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const p = Number((entry.target as HTMLElement).dataset.fluidPage);
          if (!Number.isFinite(p)) continue;
          if (entry.isIntersecting && entry.intersectionRect.height > 0) {
            visibleRatios.set(p, entry.intersectionRect.height);
          } else {
            visibleRatios.delete(p);
          }
        }
        if (performance.now() < suppressSyncUntilRef.current || visibleRatios.size === 0) return;

        let bestPage = -1;
        let bestHeight = -1;
        for (const [p, h] of visibleRatios) {
          if (h > bestHeight + 4 || (Math.abs(h - bestHeight) <= 4 && p < bestPage)) {
            bestHeight = h;
            bestPage = p;
          }
        }
        if (bestPage > 0) onVisiblePage(bestPage);
      },
      { root, threshold: [0, 0.15, 0.35, 0.55, 0.75, 0.95] }
    );

    root.querySelectorAll('[data-fluid-page]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [numPages, scrollRef, onVisiblePage]);

  return (
    <div className="rd-fluid-stream">
      {range(1, numPages).map((page) => (
        <FluidPageTile
          key={page}
          pdfDoc={pdfDoc}
          pageNumber={page}
          numPages={numPages}
          baseSize={sizeOverrides[page] ?? defaultPageSize}
          zoom={zoom}
          availWidth={availWidth}
          isCompact={isCompact}
          inWindow={windowPages.has(page)}
          night={night}
          activeTerm={activeTerm}
          renderNonce={renderNonce}
          queue={queue}
          onSizeKnown={handleSizeKnown}
        />
      ))}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Reader                                                              */
/* ------------------------------------------------------------------ */

export function PdfReaderModal({
  publication,
  initialPage,
  onClose,
  onPagePersist
}: PdfReaderModalProps) {
  const titleId = useId();
  const railId = useId();
  const menuId = useId();

  const isCompact = useMediaQuery(MQ_COMPACT);
  const isPhone = useMediaQuery(MQ_PHONE);

  // Resume: explicit page from the caller (> 1) wins, otherwise the locally remembered one.
  const [startPage] = useState(() =>
    initialPage && initialPage > 1
      ? Math.trunc(initialPage)
      : (getReadingProgress(publication.id)?.page ?? 1)
  );
  const appIsDark = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  )[0];

  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total?: number }>({ loaded: 0 });
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(startPage);
  const [pageInput, setPageInput] = useState(String(startPage));

  const [mode, setMode] = useState<ReaderMode>(readStoredMode);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [displayScale, setDisplayScale] = useState(1);
  const [availWidth, setAvailWidth] = useState(0);
  const [defaultPageSize, setDefaultPageSize] = useState<PageSize>({ width: 595, height: 842 });
  const [night, setNight] = useState(appIsDark);
  const [reflowFont, setReflowFont] = useState(readStoredFont);
  const [reflowJump, setReflowJump] = useState({ page: startPage, nonce: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [fsHudVisible, setFsHudVisible] = useState(true);

  const [showThumbs, setShowThumbs] = useState(() => window.matchMedia(MQ_WIDE).matches);
  const [menuOpen, setMenuOpen] = useState(false);

  const [renderBusy, setRenderBusy] = useState(false);
  const [showBusy, setShowBusy] = useState(false);
  const [painted, setPainted] = useState(false);
  const [renderFailed, setRenderFailed] = useState(false);
  const [renderNonce, setRenderNonce] = useState(0);
  const [renderVersion, setRenderVersion] = useState(0);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeTerm, setActiveTerm] = useState('');
  const [search, setSearch] = useState<SearchState>(IDLE_SEARCH);
  const [activeResultIdx, setActiveResultIdx] = useState(0);

  const [announcedPage, setAnnouncedPage] = useState(startPage);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textHostRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<Element | null>(null);

  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const reflowCacheRef = useRef(new Map<number, ReflowBlock[]>());
  const searchControllerRef = useRef<AbortController | null>(null);
  const renderGenRef = useRef(0);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerTaskRef = useRef<{ cancel: () => void } | null>(null);
  const renderSettledRef = useRef<Promise<void>>(Promise.resolve());
  const displayScaleRef = useRef(1);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const fsTapRef = useRef<{ x: number; y: number } | null>(null);
  const exitedNativeFsAtRef = useRef(0);
  const prevNativeFsRef = useRef(false);
  const pendingSearchFocusRef = useRef(false);
  const closingRef = useRef(false);
  const lastPersistedRef = useRef(startPage);

  // Always-fresh values for stable callbacks and native listeners.
  const modeRef = useRef(mode);
  const fullscreenRef = useRef(fullscreen);
  const isCompactRef = useRef(isCompact);
  const currentPageRef = useRef(currentPage);
  const numPagesRef = useRef(numPages);
  const onCloseRef = useRef(onClose);
  const onPagePersistRef = useRef(onPagePersist);
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  const closeTopLayerRef = useRef<() => boolean>(() => false);

  useEffect(() => {
    modeRef.current = mode;
    fullscreenRef.current = fullscreen;
    isCompactRef.current = isCompact;
    currentPageRef.current = currentPage;
    numPagesRef.current = numPages;
    onCloseRef.current = onClose;
    onPagePersistRef.current = onPagePersist;
    displayScaleRef.current = displayScale;
  });

  const lang = publication.language === 'other' ? undefined : publication.language;
  const pdfTarget = safeExternalUrl(publication.pdfUrl) ?? safeExternalUrl(publication.scieloUrl);
  const sourceUrl = safeExternalUrl(publication.scieloUrl) ?? safeExternalUrl(publication.pdfUrl);
  const directPdfUrl = safeExternalUrl(publication.pdfUrl);
  const ready = loadState.status === 'ready' && pdfDoc !== null;

  /* ---- native <dialog> lifecycle ---------------------------------- */

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    closingRef.current = false;
    openerRef.current = document.activeElement;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.classList.add('has-open-dialog');

    if (!dialog.open) dialog.showModal();
    closeButtonRef.current?.focus();

    const onCancel = (e: Event) => {
      // Esc: exit native/CSS fullscreen or close top overlay first, otherwise the reader.
      e.preventDefault();
      if (performance.now() - exitedNativeFsAtRef.current < 160) return;
      if (closeTopLayerRef.current()) return;
      onCloseRef.current();
    };
    const onNativeClose = () => {
      if (!closingRef.current) onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // A parent drawer must never see the Esc that was meant for the reader.
      if (e.key === 'Escape') e.stopPropagation();
      keyHandlerRef.current(e);
    };
    const onFullscreenChange = () => {
      const docFs = document as Document & { webkitFullscreenElement?: Element | null };
      const activeFs = Boolean(document.fullscreenElement || docFs.webkitFullscreenElement);
      if (prevNativeFsRef.current && !activeFs) {
        exitedNativeFsAtRef.current = performance.now();
        setFullscreen(false);
      }
      prevNativeFsRef.current = activeFs;
    };

    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onNativeClose);
    dialog.addEventListener('keydown', onKeyDown);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);

    return () => {
      closingRef.current = true;
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onNativeClose);
      dialog.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      const docFs = document as Document & {
        webkitFullscreenElement?: Element | null;
        webkitExitFullscreen?: () => Promise<void> | void;
      };
      if (document.fullscreenElement === dialog || docFs.webkitFullscreenElement === dialog) {
        void document.exitFullscreen?.().catch(() => undefined);
        docFs.webkitExitFullscreen?.();
      }
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      if (!document.querySelector('dialog[open]')) {
        document.documentElement.classList.remove('has-open-dialog');
      }
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  /* ---- document loading ------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    const holder: { task: PDFDocumentLoadingTask | null } = { task: null };
    const reflowCache = reflowCacheRef.current;

    setLoadState({ status: 'loading' });
    setLoadProgress({ loaded: 0 });
    setPdfDoc(null);
    setPainted(false);
    setRenderFailed(false);

    if (!pdfTarget) {
      setLoadState({ status: 'error', info: pdfErrorInfo('no_pdf_available') });
      return;
    }

    const proxyUrl = buildPdfProxyUrl(pdfTarget);

    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        const task = openPdfDocument(pdfjs, proxyUrl, { keepOffline: true });
        holder.task = task;
        task.onProgress = (prog: { loaded: number; total?: number }) => {
          if (!cancelled) setLoadProgress({ loaded: prog.loaded, total: prog.total || undefined });
        };
        const doc = await task.promise;
        if (cancelled) {
          void task.destroy().catch(() => undefined);
          return;
        }
        const firstPage = await doc.getPage(1);
        const firstVp = firstPage.getViewport({ scale: 1 });
        if (!cancelled) {
          setDefaultPageSize({ width: firstVp.width || 595, height: firstVp.height || 842 });
        }
        const start = clamp(startPage, 1, doc.numPages);
        pdfDocRef.current = doc;
        numPagesRef.current = doc.numPages;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setCurrentPage(start);
        setPageInput(String(start));
        setAnnouncedPage(start);
        setReflowJump((j) => ({ page: start, nonce: j.nonce + 1 }));
        setLoadState({ status: 'ready' });
      } catch (err) {
        if (cancelled) return;
        const info = await classifyPdfError(err, proxyUrl);
        if (!cancelled) setLoadState({ status: 'error', info });
      }
    })();

    return () => {
      cancelled = true;
      searchControllerRef.current?.abort();
      renderTaskRef.current?.cancel();
      textLayerTaskRef.current?.cancel();
      reflowCache.clear();
      pdfDocRef.current = null;
      void holder.task?.destroy().catch(() => undefined);
    };
  }, [pdfTarget, loadAttempt, startPage]);

  /* ---- reading progress (debounced; flushed on close) ------------- */

  const persistNow = useCallback(() => {
    const total = numPagesRef.current;
    if (total <= 0) return;
    const page = currentPageRef.current;
    if (page === lastPersistedRef.current) return;
    lastPersistedRef.current = page;
    saveReadingProgress(publication.id, page, total);
    onPagePersistRef.current?.(page);
  }, [publication.id]);

  useEffect(() => {
    if (numPages <= 0) return;
    const timer = window.setTimeout(persistNow, 1000);
    return () => window.clearTimeout(timer);
  }, [currentPage, numPages, persistNow]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') persistNow();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', persistNow);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', persistNow);
      persistNow(); // final write when the reader closes
    };
  }, [persistNow]);

  /* ---- page navigation -------------------------------------------- */

  const goToPage = useCallback((page: number) => {
    const total = numPagesRef.current;
    if (total <= 0 || !Number.isFinite(page)) return;
    const target = clamp(Math.trunc(page), 1, total);
    setCurrentPage(target);
    setPageInput(String(target));
    if (modeRef.current === 'fluid' || modeRef.current === 'text') {
      setReflowJump((j) => ({ page: target, nonce: j.nonce + 1 }));
    } else {
      scrollRef.current?.scrollTo({ top: 0 });
    }
  }, []);

  const handleVisibleStreamPage = useCallback((page: number) => {
    setCurrentPage(page);
    setPageInput(String(page));
  }, []);

  const switchMode = useCallback((next: ReaderMode) => {
    setMode(next);
    writeStorage(MODE_KEY, next);
    if (next === 'canvas') setPainted(false);
    if (next === 'fluid' || next === 'text') {
      setReflowJump((j) => ({ page: currentPageRef.current, nonce: j.nonce + 1 }));
    }
    setMenuOpen(false);
  }, []);

  const backToPdf = useCallback(
    (page: number) => {
      setCurrentPage(page);
      setPageInput(String(page));
      switchMode('fluid');
    },
    [switchMode]
  );

  const exitFullscreen = useCallback(async () => {
    const docFs = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const dialog = dialogRef.current;
    if (dialog && (document.fullscreenElement === dialog || docFs.webkitFullscreenElement === dialog)) {
      try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else docFs.webkitExitFullscreen?.();
      } catch {
        // Native exit ignored: CSS fullscreen still turns off below.
      }
    }
    prevNativeFsRef.current = false;
    setFullscreen(false);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    setMenuOpen(false);
    if (fullscreenRef.current) {
      await exitFullscreen();
      return;
    }
    setShowThumbs(false);
    setFsHudVisible(true);
    setFullscreen(true);
    const dialog = dialogRef.current as
      | (HTMLDialogElement & { webkitRequestFullscreen?: () => Promise<void> | void })
      | null;
    if (!dialog) return;
    try {
      if (dialog.requestFullscreen) {
        await dialog.requestFullscreen();
        prevNativeFsRef.current = true;
      } else if (dialog.webkitRequestFullscreen) {
        await dialog.webkitRequestFullscreen();
        prevNativeFsRef.current = true;
      }
    } catch {
      // iPhone X/XR & iOS Safari reject or omit Element.requestFullscreen():
      // CSS `.coleebri-reader--fullscreen` provides full edge-to-edge reading seamlessly.
      prevNativeFsRef.current = false;
    }
  }, [exitFullscreen]);

  // Debounced announcement for the live region (scrolling must not spam screen readers).
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncedPage(currentPage), 600);
    return () => window.clearTimeout(timer);
  }, [currentPage]);

  /* ---- available width (fit-to-width) ----------------------------- */

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timer = 0;
    const measure = () => {
      const cs = getComputedStyle(el);
      const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const next = Math.max(0, Math.floor(inner));
      setAvailWidth((prev) => (Math.abs(prev - next) >= 2 ? next : prev));
    };
    measure();
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 80);
    });
    observer.observe(el);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [fullscreen, showThumbs]);

  /* ---- canvas rendering (serialised: one render on the canvas at a time) */

  useEffect(() => {
    if (!pdfDoc || mode !== 'canvas') return;
    if (zoom === 'fit' && availWidth <= 0) return;

    const gen = ++renderGenRef.current;
    const isStale = () => gen !== renderGenRef.current;
    const previousSettled = renderSettledRef.current;
    let resolveSettled: () => void = () => undefined;
    renderSettledRef.current = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    renderTaskRef.current?.cancel();
    textLayerTaskRef.current?.cancel();

    void (async () => {
      try {
        // Wait for the previous render to actually stop before touching the canvas again.
        await previousSettled;
        if (isStale()) return;
        setRenderBusy(true);
        setRenderFailed(false);

        const page = await pdfDoc.getPage(currentPage);
        if (isStale()) return;

        const unscaled = page.getViewport({ scale: 1 });
        const scale = resolvePageScale(unscaled.width, zoom, availWidth);
        setDisplayScale(scale);

        const canvas = canvasRef.current;
        const host = textHostRef.current;
        if (!canvas || !host) return;

        const paintedResult = await renderPdfBitmap(
          page,
          scale,
          getCanvasBudget(isCompact, false),
          canvas,
          isStale,
          (t) => {
            renderTaskRef.current = t;
          }
        );
        if (!paintedResult || isStale()) return;

        host.replaceChildren(); // the old text layer no longer matches the new bitmap
        setPainted(true);

        const textOk = await mountPdfTextLayer(
          page,
          paintedResult.viewport,
          scale,
          host,
          isStale,
          (t) => {
            textLayerTaskRef.current = t;
          }
        );
        if (textOk && !isStale()) setRenderVersion((v) => v + 1);
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        if (name !== 'RenderingCancelledException' && name !== 'AbortException' && !isStale()) {
          setRenderFailed(true);
        }
      } finally {
        resolveSettled();
        if (!isStale()) setRenderBusy(false);
      }
    })();

    return () => {
      renderGenRef.current++;
      renderTaskRef.current?.cancel();
      textLayerTaskRef.current?.cancel();
    };
  }, [pdfDoc, mode, currentPage, zoom, availWidth, isCompact, renderNonce]);

  useEffect(() => {
    if (!renderBusy) {
      setShowBusy(false);
      return;
    }
    const timer = window.setTimeout(() => setShowBusy(true), 350);
    return () => window.clearTimeout(timer);
  }, [renderBusy]);

  // Search highlights live outside the render pipeline: changing the term never repaints the page.
  useEffect(() => {
    const host = textHostRef.current;
    if (!host) return;
    clearHighlights(host);
    if (activeTerm) applyHighlights(host, activeTerm);
  }, [renderVersion, activeTerm, mode]);

  /* ---- zoom -------------------------------------------------------- */

  const zoomBy = useCallback((delta: number) => {
    setZoom(clamp(Number((displayScaleRef.current + delta).toFixed(2)), MIN_ZOOM, MAX_ZOOM));
  }, []);

  const changeFont = useCallback((delta: number) => {
    setReflowFont((prev) => {
      const next = clamp(prev + delta, FONT_MIN, FONT_MAX);
      writeStorage(FONT_KEY, String(next));
      return next;
    });
  }, []);

  /* ---- in-document search (cancellable, accent/case-insensitive) --- */

  const clearSearch = useCallback(() => {
    searchControllerRef.current?.abort();
    searchControllerRef.current = null;
    setSearch(IDLE_SEARCH);
    setActiveTerm('');
    setActiveResultIdx(0);
  }, []);

  const stopSearch = useCallback(() => {
    searchControllerRef.current?.abort();
    searchControllerRef.current = null;
    setSearch((s) => (s.status === 'running' ? { ...s, status: 'stopped' } : s));
  }, []);

  const runSearch = useCallback(
    async (rawTerm: string) => {
      searchControllerRef.current?.abort();
      const doc = pdfDocRef.current;
      const term = rawTerm.replace(/\s+/g, ' ').trim();
      const needle = foldQuery(term);
      if (!doc || needle.length < 2) {
        clearSearch();
        return;
      }

      const controller = new AbortController();
      searchControllerRef.current = controller;
      const results: SearchResult[] = [];
      let jumped = false;

      setActiveTerm(term);
      setActiveResultIdx(0);
      setSearch({ status: 'running', scanned: 0, results: [] });

      try {
        for (let p = 1; p <= doc.numPages; p++) {
          if (controller.signal.aborted) return;
          const page = await doc.getPage(p);
          const content = await page.getTextContent();
          if (controller.signal.aborted) return;

          const haystack = foldWithMap(itemsToSearchText(content.items)).folded;
          const count = countOccurrences(haystack, needle);
          if (count > 0) {
            results.push({ page: p, count });
            if (!jumped) {
              jumped = true;
              goToPage(p);
            }
          }
          if (count > 0 || p % 5 === 0) {
            setSearch({ status: 'running', scanned: p, results: [...results] });
          }
        }
        if (!controller.signal.aborted) {
          setSearch({ status: 'done', scanned: doc.numPages, results });
        }
      } catch {
        if (!controller.signal.aborted) {
          setSearch((s) => ({ ...s, status: 'error' }));
        }
      }
    },
    [clearSearch, goToPage]
  );

  const stepResult = useCallback(
    (delta: number) => {
      const { results } = search;
      if (results.length === 0) return;
      const next = (activeResultIdx + delta + results.length) % results.length;
      setActiveResultIdx(next);
      goToPage(results[next].page);
    },
    [activeResultIdx, goToPage, search]
  );

  const matchPageSet = useMemo(() => new Set(search.results.map((r) => r.page)), [search.results]);

  const focusSearch = useCallback(() => {
    if (searchInputRef.current) {
      searchInputRef.current.focus();
      searchInputRef.current.select();
    } else {
      pendingSearchFocusRef.current = true;
      setMenuOpen(true);
    }
  }, []);

  useEffect(() => {
    if (menuOpen && pendingSearchFocusRef.current) {
      pendingSearchFocusRef.current = false;
      searchInputRef.current?.focus();
    }
  }, [menuOpen]);

  /* ---- "Más" menu: outside click ----------------------------------- */

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!isCompact) setMenuOpen(false);
  }, [isCompact]);

  closeTopLayerRef.current = () => {
    if (menuOpen) {
      setMenuOpen(false);
      menuButtonRef.current?.focus();
      return true;
    }
    if (showThumbs && isPhone) {
      setShowThumbs(false);
      return true;
    }
    if (fullscreenRef.current) {
      void exitFullscreen();
      return true;
    }
    return false;
  };

  /* ---- thumbnail rail: keep the active tile in view ---------------- */

  useEffect(() => {
    if (!showThumbs) return;
    const rail = railRef.current;
    const tile = rail?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!rail || !tile) return;
    const r = rail.getBoundingClientRect();
    const t = tile.getBoundingClientRect();
    if (t.top < r.top) rail.scrollTop -= r.top - t.top + 8;
    else if (t.bottom > r.bottom) rail.scrollTop += t.bottom - r.bottom + 8;
  }, [currentPage, showThumbs, pdfDoc]);

  const selectThumbnail = useCallback(
    (page: number) => {
      goToPage(page);
      if (window.matchMedia(MQ_PHONE).matches) setShowThumbs(false);
    },
    [goToPage]
  );

  /* ---- keyboard ---------------------------------------------------- */

  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const target = e.target instanceof Element ? e.target : null;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (ready) focusSearch();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!ready || isTextEntry(target)) return;

    const scroller = scrollRef.current;
    if (!scroller) return;
    const canvasMode = modeRef.current === 'canvas';

    switch (e.key) {
      case 'ArrowRight':
        if (canvasMode) {
          e.preventDefault();
          goToPage(currentPageRef.current + 1);
        }
        break;
      case 'ArrowLeft':
        if (canvasMode) {
          e.preventDefault();
          goToPage(currentPageRef.current - 1);
        }
        break;
      case 'ArrowDown':
      case 'ArrowUp':
      case 'PageDown':
      case 'PageUp':
      case ' ': {
        // Space on a focused button/link activates it; keys inside the thumbnail rail are left alone.
        if (target?.closest('button, a[href], summary, [role="button"]') && e.key === ' ') return;
        if (target?.closest('.rd-rail') || target?.closest('.rd-menu')) return;
        const backwards = e.key === 'ArrowUp' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey);
        const dir = backwards ? -1 : 1;
        const canScroll =
          dir > 0
            ? scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2
            : scroller.scrollTop > 2;
        e.preventDefault();
        if (canScroll) {
          const small = e.key === 'ArrowDown' || e.key === 'ArrowUp';
          const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          scroller.scrollBy({
            top: dir * (small ? 56 : scroller.clientHeight * 0.9),
            behavior: small || reduce ? 'auto' : 'smooth'
          });
        } else if (canvasMode) {
          // End of the page area: continue with the neighbouring page.
          goToPage(currentPageRef.current + dir);
        }
        break;
      }
      case 'f':
      case 'F':
        e.preventDefault();
        void toggleFullscreen();
        break;
      default:
        break;
    }
  };

  /* ---- touch: swipe to turn pages (single finger, clearly horizontal) */

  const onTouchStart = (e: ReactTouchEvent) => {
    swipeRef.current =
      e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  };

  const onTouchMove = (e: ReactTouchEvent) => {
    if (e.touches.length > 1) swipeRef.current = null; // pinch
  };

  const onTouchEnd = (e: ReactTouchEvent) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || e.touches.length > 0 || e.changedTouches.length !== 1) return;
    if (modeRef.current !== 'canvas') return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) <= 60 || Math.abs(dx) <= 1.5 * Math.abs(dy)) return;
    // A zoomed page that scrolls sideways owns horizontal gestures.
    if (scroller.scrollWidth > scroller.clientWidth + 2) return;
    // Do not steal a text-selection drag.
    if (window.getSelection()?.toString()) return;
    goToPage(currentPageRef.current + (dx < 0 ? 1 : -1));
  };

  /* ---- render helpers --------------------------------------------- */

  const submitPage = (e: FormEvent) => {
    e.preventDefault();
    const parsed = Number.parseInt(pageInput, 10);
    if (Number.isNaN(parsed)) setPageInput(String(currentPage));
    else goToPage(parsed);
  };

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    setMenuOpen(false);
    void runSearch(searchQuery);
  };

  const progressPct =
    loadProgress.total && loadProgress.total > 0
      ? Math.min(100, Math.round((loadProgress.loaded / loadProgress.total) * 100))
      : null;

  const isFluid = mode === 'fluid';
  const isText = mode === 'text';
  const totalHits = search.results.reduce((n, r) => n + r.count, 0);
  const zoomLabel = `${Math.round(displayScale * 100)}%`;
  const rootClass = [
    'coleebri-reader',
    night ? 'dark' : appIsDark ? 'coleebri-reader--paper' : '',
    fullscreen ? 'coleebri-reader--fullscreen' : ''
  ]
    .filter(Boolean)
    .join(' ');

  const searchForm = (
    <form className="rd-search" role="search" onSubmit={submitSearch}>
      <Search size={16} aria-hidden="true" />
      <input
        ref={searchInputRef}
        type="search"
        className="rd-input"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Buscar en el documento"
        aria-label="Buscar en el documento"
        enterKeyHint="search"
        autoComplete="off"
        disabled={!ready}
      />
    </form>
  );

  const zoomControls = (
    <div className="rd-group" role="group" aria-label="Zoom">
      <button
        type="button"
        className="rd-btn rd-btn--icon"
        aria-label="Alejar"
        title="Alejar"
        disabled={displayScale <= MIN_ZOOM + 0.01}
        onClick={() => zoomBy(-ZOOM_STEP)}
      >
        <ZoomOut size={16} />
      </button>
      <span className="rd-value" aria-live="off">
        {zoomLabel}
      </span>
      <button
        type="button"
        className="rd-btn rd-btn--icon"
        aria-label="Acercar"
        title="Acercar"
        disabled={displayScale >= MAX_ZOOM - 0.01}
        onClick={() => zoomBy(ZOOM_STEP)}
      >
        <ZoomIn size={16} />
      </button>
      <button
        type="button"
        className="rd-btn rd-btn--icon"
        aria-label="Ajustar al ancho"
        title="Ajustar al ancho"
        aria-pressed={zoom === 'fit'}
        onClick={() => setZoom('fit')}
      >
        <Maximize2 size={16} />
      </button>
    </div>
  );

  const fontControls = (
    <div className="rd-group" role="group" aria-label="Tamaño del texto">
      <button
        type="button"
        className="rd-btn rd-btn--icon"
        aria-label="Reducir tamaño del texto"
        title="Reducir tamaño del texto"
        disabled={reflowFont <= FONT_MIN}
        onClick={() => changeFont(-FONT_STEP)}
      >
        <span aria-hidden="true" style={{ fontSize: '0.8125rem' }}>
          A−
        </span>
      </button>
      <span className="rd-value">{reflowFont}px</span>
      <button
        type="button"
        className="rd-btn rd-btn--icon"
        aria-label="Aumentar tamaño del texto"
        title="Aumentar tamaño del texto"
        disabled={reflowFont >= FONT_MAX}
        onClick={() => changeFont(FONT_STEP)}
      >
        <span aria-hidden="true" style={{ fontSize: '1.0625rem' }}>
          A+
        </span>
      </button>
    </div>
  );

  const pageField = (
    <form className="rd-pagefield" onSubmit={submitPage}>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        className="rd-input"
        value={pageInput}
        onChange={(e) => setPageInput(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Número de página"
        disabled={!ready}
      />
      <span aria-hidden="true">/ {numPages || '—'}</span>
    </form>
  );

  const prevButton = (
    <button
      type="button"
      className="rd-btn rd-btn--icon"
      aria-label="Página anterior"
      title="Página anterior"
      disabled={!ready || currentPage <= 1}
      onClick={() => goToPage(currentPage - 1)}
    >
      <ChevronLeft size={18} />
    </button>
  );

  const nextButton = (
    <button
      type="button"
      className="rd-btn rd-btn--icon"
      aria-label="Página siguiente"
      title="Página siguiente"
      disabled={!ready || currentPage >= numPages}
      onClick={() => goToPage(currentPage + 1)}
    >
      <ChevronRight size={18} />
    </button>
  );

  const nightButton = (
    <button
      type="button"
      className="rd-btn"
      aria-pressed={night}
      title="Modo nocturno"
      onClick={() => setNight((n) => !n)}
    >
      {night ? <Moon size={16} /> : <Sun size={16} />}
      <span>Nocturno</span>
    </button>
  );

  const reflowButton = (
    <button
      type="button"
      className={isCompact ? 'rd-btn rd-btn--icon' : 'rd-btn'}
      aria-pressed={isFluid}
      aria-label="Lectura fluida"
      title="Lectura fluida: desplazamiento continuo por las páginas del PDF"
      disabled={!ready}
      onClick={() => switchMode(isFluid ? 'canvas' : 'fluid')}
    >
      <BookOpenText size={18} />
      {!isCompact && <span>Lectura fluida</span>}
    </button>
  );

  const textModeButton = (
    <button
      type="button"
      className={isCompact ? 'rd-btn' : 'rd-btn rd-btn--icon'}
      aria-pressed={isText}
      aria-label="Modo solo texto"
      title="Solo texto adaptable (sin imágenes)"
      disabled={!ready}
      onClick={() => switchMode(isText ? 'fluid' : 'text')}
    >
      <FileText size={16} />
      {isCompact && <span>Solo texto</span>}
    </button>
  );

  const fullscreenButton = (
    <button
      type="button"
      className="rd-btn rd-btn--icon"
      aria-label={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
      title={fullscreen ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)'}
      aria-pressed={fullscreen}
      onClick={() => void toggleFullscreen()}
    >
      {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
    </button>
  );

  const downloadLink = directPdfUrl ? (
    <a
      className={isCompact ? 'rd-btn' : 'rd-btn rd-btn--icon'}
      href={directPdfUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Abrir el PDF original en otra pestaña"
      title="Abrir el PDF original"
    >
      <Download size={16} />
      {isCompact && <span>Abrir el PDF original</span>}
    </a>
  ) : null;

  const errorInfo = loadState.status === 'error' ? loadState.info : null;

  return (
    <dialog
      ref={dialogRef}
      className={rootClass}
      aria-labelledby={titleId}
    >
      {/* Header */}
      <header className="rd-header">
        <button
          type="button"
          className="rd-btn rd-btn--icon"
          aria-label="Miniaturas de páginas"
          title="Miniaturas de páginas"
          aria-pressed={showThumbs}
          aria-controls={railId}
          disabled={!ready}
          onClick={() => setShowThumbs((s) => !s)}
        >
          <PanelLeft size={18} />
        </button>

        <div className="rd-title-block">
          <h2 className="rd-title" id={titleId}>
            {publication.title}
          </h2>
          <p className="rd-subtitle">
            {publication.authors[0] || publication.publisher}
            {publication.collection ? ` · ${publication.collection}` : ''}
          </p>
        </div>

        {!isCompact && ready && (
          <>
            <div className="rd-group" role="group" aria-label="Navegación de páginas">
              {prevButton}
              {pageField}
              {nextButton}
            </div>
            {isText ? fontControls : zoomControls}
            {searchForm}
          </>
        )}

        <div className="rd-header-actions">
          {reflowButton}
          {!isCompact && ready && textModeButton}
          {!isCompact && nightButton}
          {!isCompact && downloadLink}
          {fullscreenButton}
          {isCompact && (
            <button
              ref={menuButtonRef}
              type="button"
              className="rd-btn rd-btn--icon"
              aria-label="Más opciones"
              title="Más opciones"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <Ellipsis size={18} />
            </button>
          )}
          <button
            ref={closeButtonRef}
            type="button"
            className="rd-btn rd-btn--icon rd-btn--primary"
            aria-label="Cerrar lector"
            title="Cerrar lector"
            onClick={() => onClose()}
          >
            <X size={18} />
          </button>
        </div>

        {isCompact && menuOpen && (
          <div ref={menuRef} id={menuId} className="rd-menu">
            {ready && searchForm}
            {ready && !isText && <div className="rd-menu-row">{zoomControls}</div>}
            <div className="rd-menu-row">
              {nightButton}
              {ready && textModeButton}
            </div>
            {downloadLink && <div className="rd-menu-row">{downloadLink}</div>}
          </div>
        )}
      </header>

      {/* Search results strip */}
      {search.status !== 'idle' && (
        <div className="rd-searchbar" role="status" aria-live="polite">
          {search.status === 'running' && (
            <>
              <Loader2 className="rd-spin" size={16} aria-hidden="true" />
              <span>
                Buscando «{activeTerm}»: página {search.scanned} de {numPages}
              </span>
              <button type="button" className="rd-btn" onClick={stopSearch}>
                Detener
              </button>
            </>
          )}
          {search.status === 'error' && <span>No se pudo completar la búsqueda. Inténtalo de nuevo.</span>}
          {(search.status === 'done' || search.status === 'stopped') && search.results.length === 0 && (
            <span>
              Sin resultados para «<strong>{activeTerm}</strong>»
              {search.status === 'stopped' ? ` (búsqueda detenida en la página ${search.scanned})` : ''}.
            </span>
          )}
          {search.results.length > 0 && search.status !== 'error' && (
            <>
              <span>
                <strong>{totalHits}</strong> {plural(totalHits, 'coincidencia', 'coincidencias')} en{' '}
                <strong>{search.results.length}</strong>{' '}
                {plural(search.results.length, 'página', 'páginas')}
                {search.status === 'stopped' ? ' (búsqueda detenida)' : ''}
              </span>
              <span className="rd-group" role="group" aria-label="Resultados de búsqueda">
                <button
                  type="button"
                  className="rd-btn rd-btn--icon"
                  aria-label="Resultado anterior"
                  onClick={() => stepResult(-1)}
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="rd-value">
                  {activeResultIdx + 1} de {search.results.length}
                </span>
                <button
                  type="button"
                  className="rd-btn rd-btn--icon"
                  aria-label="Resultado siguiente"
                  onClick={() => stepResult(1)}
                >
                  <ChevronRight size={16} />
                </button>
              </span>
            </>
          )}
          <button
            type="button"
            className="rd-btn rd-btn--icon rd-btn--ghost"
            aria-label="Borrar búsqueda"
            title="Borrar búsqueda"
            onClick={clearSearch}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Body */}
      <div className="rd-body">
        {showThumbs && pdfDoc && (
          <aside ref={railRef} id={railId} className="rd-rail" aria-label="Miniaturas de páginas">
            <h3 className="rd-rail-title">Páginas ({numPages})</h3>
            <div className="rd-rail-list">
              {range(1, numPages).map((page) => (
                <ThumbnailTile
                  key={page}
                  pdfDoc={pdfDoc}
                  pageNumber={page}
                  isActive={page === currentPage}
                  isMatch={matchPageSet.has(page)}
                  onSelect={selectThumbnail}
                />
              ))}
            </div>
          </aside>
        )}

        <div
          ref={scrollRef}
          className="rd-scroll"
          data-mode={isText ? 'reflow' : isFluid ? 'fluid' : 'canvas'}
          data-state={loadState.status}
          tabIndex={0}
          role="region"
          aria-label="Contenido del documento"
          style={{ '--rd-reflow-size': `${reflowFont}px` } as CSSProperties}
          onPointerDown={(e) => {
            if (fullscreen) fsTapRef.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerUp={(e) => {
            if (!fullscreen || !fsTapRef.current) return;
            const dx = Math.abs(e.clientX - fsTapRef.current.x);
            const dy = Math.abs(e.clientY - fsTapRef.current.y);
            fsTapRef.current = null;
            if (dx > 8 || dy > 8) return;
            if ((e.target as Element | null)?.closest('button, a, input, select')) return;
            if (window.getSelection()?.toString()) return;
            setFsHudVisible((v) => !v);
          }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={() => {
            swipeRef.current = null;
            fsTapRef.current = null;
          }}
        >
          {loadState.status === 'loading' && (
            <div className="rd-loader-stage">
              <ReaderLoadingView
                publication={publication}
                stage="pdf"
                progressPct={progressPct}
                loadedBytes={loadProgress.loaded}
                totalBytes={loadProgress.total}
              />
            </div>
          )}

          {errorInfo && (
            <div className="rd-state" role="alert">
              <TriangleAlert className="rd-state-icon rd-state-icon--warn" size={32} aria-hidden="true" />
              <h3 className="rd-state-title">No se pudo abrir el documento</h3>
              <p className="rd-state-text">{errorInfo.message}</p>
              <div className="rd-state-actions">
                {errorInfo.retryable && pdfTarget && (
                  <button
                    type="button"
                    className="rd-btn rd-btn--primary"
                    onClick={() => setLoadAttempt((n) => n + 1)}
                  >
                    <RefreshCw size={16} />
                    Reintentar
                  </button>
                )}
                {sourceUrl && (
                  <a className="rd-btn" href={sourceUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={16} />
                    Abrir en la fuente original
                  </a>
                )}
                {directPdfUrl && directPdfUrl !== sourceUrl && (
                  <a className="rd-btn" href={directPdfUrl} target="_blank" rel="noopener noreferrer">
                    <Download size={16} />
                    Abrir PDF directo
                  </a>
                )}
              </div>
            </div>
          )}

          {ready && pdfDoc && !isFluid && !isText && (
            <div className="rd-stage">
              {showBusy && (
                <div className="rd-busy" role="status">
                  <Loader2 className="rd-spin" size={14} aria-hidden="true" />
                  Dibujando página {currentPage}…
                </div>
              )}
              <canvas
                ref={canvasRef}
                className="rd-canvas"
                data-night={night}
                role="img"
                aria-label={`Página ${currentPage} de ${numPages}`}
              />
              <div ref={textHostRef} className="rd-textlayer-host" />
              {!painted && !renderFailed && (
                <div className="rd-stage-overlay" aria-hidden="true">
                  <Loader2 className="rd-spin rd-state-icon--busy" size={28} />
                </div>
              )}
              {renderFailed && (
                <div className="rd-stage-overlay" style={{ pointerEvents: 'auto' }}>
                  <div className="rd-state" role="alert">
                    <p className="rd-state-text">No se pudo dibujar esta página.</p>
                    <div className="rd-state-actions">
                      <button
                        type="button"
                        className="rd-btn rd-btn--primary"
                        onClick={() => setRenderNonce((n) => n + 1)}
                      >
                        <RefreshCw size={16} />
                        Reintentar
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {ready && pdfDoc && isFluid && (
            <FluidPdfView
              pdfDoc={pdfDoc}
              numPages={numPages}
              defaultPageSize={defaultPageSize}
              jumpTo={reflowJump}
              scrollRef={scrollRef}
              zoom={zoom}
              availWidth={availWidth}
              isCompact={isCompact}
              night={night}
              activeTerm={activeTerm}
              renderNonce={renderNonce}
              onScaleChange={setDisplayScale}
              onVisiblePage={handleVisibleStreamPage}
            />
          )}

          {ready && pdfDoc && isText && (
            <ReflowView
              pdfDoc={pdfDoc}
              numPages={numPages}
              jumpTo={reflowJump}
              scrollRef={scrollRef}
              cache={reflowCacheRef.current}
              lang={lang}
              onVisiblePage={handleVisibleStreamPage}
              onSwitchToOriginal={backToPdf}
            />
          )}
        </div>
      </div>

      {/* Compact bottom bar (phones & tablets) */}
      {isCompact && ready && !fullscreen && (
        <nav className="rd-bottombar" aria-label="Navegación del documento">
          {prevButton}
          <div className="rd-bottombar-center">
            {isText ? (
              fontControls
            ) : (
              <button
                type="button"
                className="rd-btn rd-btn--icon"
                aria-label="Ajustar al ancho"
                title="Ajustar al ancho"
                aria-pressed={zoom === 'fit'}
                onClick={() => setZoom('fit')}
              >
                <Maximize2 size={18} />
              </button>
            )}
            {pageField}
          </div>
          {nextButton}
        </nav>
      )}

      {/* Fullscreen floating controls (all screens, incl. iPhone X/XR Safari fallback) */}
      {fullscreen && ready && (
        fsHudVisible ? (
          <div className="rd-fs-hud" role="toolbar" aria-label="Controles de pantalla completa">
            {prevButton}
            <span className="rd-value" aria-live="off">
              {currentPage} / {numPages}
            </span>
            {nextButton}
            <button
              type="button"
              className="rd-btn rd-btn--icon"
              aria-label="Lectura fluida"
              title="Lectura fluida"
              aria-pressed={isFluid}
              onClick={() => switchMode(isFluid ? 'canvas' : 'fluid')}
            >
              <BookOpenText size={17} />
            </button>
            <button
              type="button"
              className="rd-btn rd-btn--icon"
              aria-label={night ? 'Modo papel' : 'Modo nocturno'}
              title={night ? 'Modo papel' : 'Modo nocturno'}
              aria-pressed={night}
              onClick={() => setNight((n) => !n)}
            >
              {night ? <Moon size={16} /> : <Sun size={16} />}
            </button>
            <button
              type="button"
              className="rd-btn"
              aria-label="Salir de pantalla completa"
              title="Salir de pantalla completa (Esc / F)"
              onClick={() => void exitFullscreen()}
            >
              <Minimize size={16} />
              {!isCompact && <span>Salir</span>}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="rd-btn rd-btn--icon rd-fs-corner-exit"
            aria-label="Salir de pantalla completa"
            title="Salir de pantalla completa"
            onClick={() => void exitFullscreen()}
          >
            <Minimize size={18} />
          </button>
        )
      )}

      <div className="rd-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {ready ? `Página ${announcedPage} de ${numPages}` : ''}
      </div>
    </dialog>
  );
}
