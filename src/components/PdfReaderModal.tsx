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
  Loader2,
  Maximize2,
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
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import '../styles/reader.css';
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

type ReaderMode = 'canvas' | 'reflow';

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
  return readStorage(MODE_KEY) === 'reflow' ? 'reflow' : 'canvas';
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
  const [night, setNight] = useState(appIsDark);
  const [reflowFont, setReflowFont] = useState(readStoredFont);
  const [reflowJump, setReflowJump] = useState({ page: startPage, nonce: 0 });

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
  const pendingSearchFocusRef = useRef(false);
  const closingRef = useRef(false);
  const lastPersistedRef = useRef(startPage);

  // Always-fresh values for stable callbacks and native listeners.
  const modeRef = useRef(mode);
  const currentPageRef = useRef(currentPage);
  const numPagesRef = useRef(numPages);
  const onCloseRef = useRef(onClose);
  const onPagePersistRef = useRef(onPagePersist);
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  const closeTopLayerRef = useRef<() => boolean>(() => false);

  useEffect(() => {
    modeRef.current = mode;
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

    if (!dialog.open) dialog.showModal();
    closeButtonRef.current?.focus();

    const onCancel = (e: Event) => {
      // Esc: close our own top layer first (menu / sheet), otherwise the reader.
      e.preventDefault();
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

    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onNativeClose);
    dialog.addEventListener('keydown', onKeyDown);

    return () => {
      closingRef.current = true;
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onNativeClose);
      dialog.removeEventListener('keydown', onKeyDown);
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
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
    if (modeRef.current === 'reflow') {
      setReflowJump((j) => ({ page: target, nonce: j.nonce + 1 }));
    } else {
      scrollRef.current?.scrollTo({ top: 0 });
    }
  }, []);

  const handleVisibleReflowPage = useCallback((page: number) => {
    setCurrentPage(page);
    setPageInput(String(page));
  }, []);

  const switchMode = useCallback((next: ReaderMode) => {
    setMode(next);
    writeStorage(MODE_KEY, next);
    if (next === 'canvas') setPainted(false);
    if (next === 'reflow') {
      setReflowJump((j) => ({ page: currentPageRef.current, nonce: j.nonce + 1 }));
    }
    setMenuOpen(false);
  }, []);

  const backToOriginal = useCallback(
    (page: number) => {
      setCurrentPage(page);
      setPageInput(String(page));
      switchMode('canvas');
    },
    [switchMode]
  );

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
      timer = window.setTimeout(measure, 150);
    });
    observer.observe(el);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

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
        const scale =
          zoom === 'fit'
            ? clamp(availWidth / unscaled.width, MIN_ZOOM, FIT_MAX)
            : clamp(zoom, MIN_ZOOM, MAX_ZOOM);
        const viewport = page.getViewport({ scale });
        setDisplayScale(scale);

        // Draw on an off-screen canvas, then blit: the visible page is never blank mid-render
        // and two render() calls can never share a canvas.
        let outScale = Math.min(window.devicePixelRatio || 1, 2);
        const pixels = viewport.width * viewport.height * outScale * outScale;
        if (pixels > MAX_CANVAS_PIXELS) {
          outScale = Math.max(0.5, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
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
        renderTaskRef.current = task;
        try {
          await task.promise;
        } finally {
          if (renderTaskRef.current === task) renderTaskRef.current = null;
        }
        if (isStale()) {
          off.width = 0;
          return;
        }

        const canvas = canvasRef.current;
        const host = textHostRef.current;
        if (!canvas || !host) return;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.getContext('2d')?.drawImage(off, 0, 0);
        off.width = 0; // release the bitmap right away (iOS memory)
        host.replaceChildren(); // the old text layer no longer matches the new bitmap
        setPainted(true);

        // Selectable / searchable text on top of the bitmap.
        const pdfjs: PdfjsModule = await loadPdfjs();
        const textContent = await page.getTextContent();
        if (isStale()) return;

        const layerEl = document.createElement('div');
        layerEl.className = 'textLayer';
        layerEl.style.setProperty('--scale-factor', String(scale));
        layerEl.style.setProperty('--total-scale-factor', String(scale));
        const textLayer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: layerEl,
          viewport
        });
        textLayerTaskRef.current = textLayer;
        await textLayer.render();
        if (isStale()) return;

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
        setRenderVersion((v) => v + 1);
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
  }, [pdfDoc, mode, currentPage, zoom, availWidth, renderNonce]);

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

  const isReflow = mode === 'reflow';
  const totalHits = search.results.reduce((n, r) => n + r.count, 0);
  const zoomLabel = `${Math.round(displayScale * 100)}%`;
  const rootClass = [
    'coleebri-reader',
    night ? 'dark' : appIsDark ? 'coleebri-reader--paper' : ''
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
      aria-pressed={isReflow}
      aria-label="Lectura fluida"
      title="Lectura fluida: texto adaptable al tamaño de tu pantalla"
      disabled={!ready}
      onClick={() => switchMode(isReflow ? 'canvas' : 'reflow')}
    >
      <BookOpenText size={18} />
      {!isCompact && <span>Lectura fluida</span>}
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
            {isReflow ? fontControls : zoomControls}
            {searchForm}
          </>
        )}

        <div className="rd-header-actions">
          {reflowButton}
          {!isCompact && nightButton}
          {!isCompact && downloadLink}
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
            {ready && !isReflow && <div className="rd-menu-row">{zoomControls}</div>}
            <div className="rd-menu-row">{nightButton}</div>
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
          data-mode={isReflow ? 'reflow' : 'canvas'}
          tabIndex={0}
          role="region"
          aria-label="Contenido del documento"
          style={{ '--rd-reflow-size': `${reflowFont}px` } as CSSProperties}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={() => {
            swipeRef.current = null;
          }}
        >
          {loadState.status === 'loading' && (
            <div className="rd-state" role="status">
              <Loader2 className="rd-spin rd-state-icon rd-state-icon--busy" size={28} aria-hidden="true" />
              <p className="rd-state-title">Abriendo el documento…</p>
              <p className="rd-state-text">
                {progressPct !== null
                  ? `${progressPct}% descargado`
                  : loadProgress.loaded > 0
                    ? `${Math.round(loadProgress.loaded / 1024)} KB descargados`
                    : 'Esto puede tardar unos segundos en conexiones lentas.'}
              </p>
              {progressPct !== null && (
                <div className="rd-progress" aria-hidden="true">
                  <span style={{ width: `${progressPct}%` }} />
                </div>
              )}
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

          {ready && pdfDoc && !isReflow && (
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

          {ready && pdfDoc && isReflow && (
            <ReflowView
                      pdfDoc={pdfDoc}
              numPages={numPages}
              jumpTo={reflowJump}
              scrollRef={scrollRef}
              cache={reflowCacheRef.current}
              lang={lang}
              onVisiblePage={handleVisibleReflowPage}
              onSwitchToOriginal={backToOriginal}
            />
          )}
        </div>
      </div>

      {/* Compact bottom bar (phones & tablets) */}
      {isCompact && ready && (
        <nav className="rd-bottombar" aria-label="Navegación del documento">
          {prevButton}
          <div className="rd-bottombar-center">
            {isReflow ? (
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

      <div className="rd-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {ready ? `Página ${announcedPage} de ${numPages}` : ''}
      </div>
    </dialog>
  );
}
