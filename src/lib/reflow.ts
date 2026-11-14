/**
 * "Lectura fluida": turns the positioned text items pdf.js extracts from a page into
 * readable paragraphs (reflowable text), entirely client-side and without any DOM.
 *
 * Pipeline per page:
 *   1. items  -> lines        (group by baseline `transform[5]` with a tolerance)
 *   2. lines  -> cleaned      (drop bare page numbers and running headers/footers)
 *   3. lines  -> blocks       (headings by font size, paragraphs by vertical gap,
 *                              de-hyphenation of words split at line end)
 *
 * The module has no dependency on pdfjs-dist at runtime: it only needs the tiny
 * structural interfaces below, which `PDFDocumentProxy` satisfies.
 *
 * Output is plain strings. Callers must render them as React text nodes (never innerHTML).
 */

export type ReflowBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string };

/** Minimal slice of `PDFPageProxy` we depend on. */
export interface ReflowPage {
  /** [xMin, yMin, xMax, yMax] in PDF user space. */
  view: number[];
  getTextContent(): Promise<{ items: ReadonlyArray<unknown> }>;
}

/** Minimal slice of `PDFDocumentProxy` we depend on. */
export interface ReflowDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<ReflowPage>;
}

interface Line {
  text: string;
  x: number;
  xEnd: number;
  /** Baseline (PDF space: grows upwards, so reading down means decreasing y). */
  y: number;
  /** Font height of the dominant item in the line. */
  height: number;
  /** Number of non-space characters (used to weight statistics). */
  chars: number;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** A line is a heading candidate when its font is at least this much larger than body text. */
const HEADING_RATIO = 1.3;
/** Max characters of a heading line (headings are short). */
const HEADING_MAX_CHARS = 140;
/**
 * Paragraph break threshold, as a multiple of the page's median line pitch (distance between
 * consecutive baselines). Normal leading is ~1.0x; paragraph spacing pushes the gap to ~1.6-2x.
 */
const PARAGRAPH_GAP_FACTOR = 1.5;
/** Header/footer bands, as a fraction of the page height. */
const TOP_BAND = 0.1;
const BOTTOM_BAND = 0.09;
/** How far (in pages) to look for repeated running headers/footers. */
const RUNNING_LOOKAROUND = [-2, -1, 1, 2];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

function isTextItem(value: unknown): value is TextItemLike {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<TextItemLike>;
  return typeof v.str === 'string' && Array.isArray(v.transform) && v.transform.length >= 6;
}

/** Median of `values` where each value counts `weight` times. */
function weightedMedian(entries: Array<{ value: number; weight: number }>): number {
  if (entries.length === 0) return 0;
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, e) => sum + e.weight, 0);
  let acc = 0;
  for (const e of sorted) {
    acc += e.weight;
    if (acc >= total / 2) return e.value;
  }
  return sorted[sorted.length - 1].value;
}

function median(values: number[]): number {
  return weightedMedian(values.map((value) => ({ value, weight: 1 })));
}

/* ------------------------------------------------------------------ */
/* 1. items -> lines                                                   */
/* ------------------------------------------------------------------ */

function buildLines(rawItems: ReadonlyArray<unknown>): Line[] {
  const lines: Line[] = [];

  interface Draft {
    parts: string[];
    x: number;
    xEnd: number;
    y: number;
    bestHeight: number;
    bestLen: number;
    chars: number;
    lastStr: string;
  }
  let cur = null as Draft | null;

  const flush = () => {
    if (!cur) return;
    const text = cur.parts.join('').replace(/\s+/g, ' ').trim();
    if (text && cur.chars > 0) {
      lines.push({
        text,
        x: cur.x,
        xEnd: cur.xEnd,
        y: cur.y,
        height: cur.bestHeight,
        chars: cur.chars
      });
    }
    cur = null;
  };

  for (const raw of rawItems) {
    if (!isTextItem(raw)) continue; // marked-content markers etc.
    const [a, b, c, d, e, f] = raw.transform;
    // Skip rotated text (margin stamps, vertical labels): it would corrupt line grouping.
    if (Math.abs(b) > Math.abs(a)) continue;

    const height = Math.hypot(c, d) || raw.height || Math.abs(d) || 0;
    const hasText = raw.str.trim().length > 0;
    const width = Number.isFinite(raw.width) ? raw.width : 0;
    const tolerance = Math.max(1.5, 0.5 * Math.max(height, cur?.bestHeight ?? 0));

    const startsNewLine =
      !cur ||
      Math.abs(f - cur.y) > tolerance ||
      // Jumped back to the left on the "same" baseline: another cell/column, not the same line.
      e < cur.xEnd - 1.5 * Math.max(height, 1);

    if (startsNewLine) {
      if (!hasText) continue; // do not start a line with whitespace
      flush();
      cur = {
        parts: [],
        x: e,
        xEnd: e,
        y: f,
        bestHeight: height,
        bestLen: 0,
        chars: 0,
        lastStr: ''
      };
    }

    const line = cur as Draft | null;
    if (!line) continue;

    // Visual gap between the previous item and this one => insert a space when the PDF
    // did not encode one explicitly.
    const gap = e - line.xEnd;
    if (
      hasText &&
      line.parts.length > 0 &&
      gap > 0.18 * Math.max(height, 1) &&
      !/\s$/.test(line.lastStr) &&
      !/^\s/.test(raw.str)
    ) {
      line.parts.push(' ');
    }

    line.parts.push(raw.str);
    line.lastStr = raw.str;
    line.xEnd = Math.max(line.xEnd, e + width);
    if (hasText) {
      const len = raw.str.trim().length;
      line.chars += len;
      if (len > line.bestLen) {
        line.bestLen = len;
        line.bestHeight = height;
      }
    }
  }
  flush();
  return lines;
}

/* ------------------------------------------------------------------ */
/* 2. header / footer / page-number removal                            */
/* ------------------------------------------------------------------ */

const BARE_PAGE_NUMBER =
  /^(?:[-–—\s]*(?:p(?:[áa]g(?:ina)?)?\.?\s*)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:\/|de|of)\s*\d{1,4})?[-–—\s]*)$/i;

/** Signature used to recognise the "same" running line across pages (digits are ignored). */
function runningSignature(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}#]+/gu, ' ')
    .trim();
}

function inBand(line: Line, view: number[]): boolean {
  const [, yMin, , yMax] = view;
  const h = yMax - yMin;
  if (h <= 0) return false;
  return line.y > yMax - TOP_BAND * h || line.y < yMin + BOTTOM_BAND * h;
}

/** Per document cache: page number -> signatures of the lines sitting in header/footer bands. */
const edgeSignatureCache = new WeakMap<object, Map<number, Promise<Set<string>>>>();

function getEdgeSignatures(doc: ReflowDocument, pageNumber: number): Promise<Set<string>> {
  let perDoc = edgeSignatureCache.get(doc);
  if (!perDoc) {
    perDoc = new Map();
    edgeSignatureCache.set(doc, perDoc);
  }
  let cached = perDoc.get(pageNumber);
  if (!cached) {
    cached = (async () => {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const sigs = new Set<string>();
      for (const line of buildLines(content.items)) {
        if (!inBand(line, page.view)) continue;
        const sig = runningSignature(line.text);
        if (sig) sigs.add(sig);
      }
      return sigs;
    })().catch(() => new Set<string>());
    perDoc.set(pageNumber, cached);
  }
  return cached;
}

async function dropPageFurniture(
  doc: ReflowDocument,
  pageNumber: number,
  lines: Line[],
  view: number[],
  signal?: AbortSignal
): Promise<Line[]> {
  const candidates = lines.filter((l) => inBand(l, view));
  if (candidates.length === 0) return lines;

  // Only fetch neighbours when there is something in the bands that could be a running line.
  const needsNeighbours = candidates.some((l) => !BARE_PAGE_NUMBER.test(l.text.trim()));
  const neighbourSigs: Set<string>[] = [];
  if (needsNeighbours) {
    for (const delta of RUNNING_LOOKAROUND) {
      const n = pageNumber + delta;
      if (n < 1 || n > doc.numPages) continue;
      checkAborted(signal);
      neighbourSigs.push(await getEdgeSignatures(doc, n));
    }
  }

  return lines.filter((line) => {
    if (!inBand(line, view)) return true;
    if (BARE_PAGE_NUMBER.test(line.text.trim())) return false;
    const sig = runningSignature(line.text);
    if (!sig) return true;
    return !neighbourSigs.some((set) => set.has(sig));
  });
}

/* ------------------------------------------------------------------ */
/* 3. lines -> blocks                                                  */
/* ------------------------------------------------------------------ */

/**
 * Joins the lines of one paragraph, de-hyphenating words split at the end of a line:
 *   "educa-" + "ción"  ->  "educación"
 * A hyphen followed by a capital/digit ("Norte-" + "Sur") is a real compound and is kept.
 */
export function joinLines(parts: string[]): string {
  let out = parts[0] ?? '';
  for (let i = 1; i < parts.length; i++) {
    const next = parts[i];
    if (!next) continue;
    if (/­$/.test(out)) {
      out = out.slice(0, -1) + next;
    } else if (/\p{L}[-‐‑]$/u.test(out)) {
      out = /^\p{Ll}/u.test(next) ? out.slice(0, -1) + next : out + next;
    } else {
      out += ' ' + next;
    }
  }
  return out.replace(/­/g, '').replace(/\s+/g, ' ').trim().normalize('NFC');
}

function headingLevel(ratio: number): 1 | 2 | 3 {
  if (ratio >= 1.8) return 1;
  if (ratio >= 1.5) return 2;
  return 3;
}

const SENTENCE_END = /[.!?:…»”"')\]]$/;

function linesToBlocks(lines: Line[]): ReflowBlock[] {
  if (lines.length === 0) return [];

  const bodyHeight = weightedMedian(lines.map((l) => ({ value: l.height, weight: l.chars })));

  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const dy = lines[i - 1].y - lines[i].y;
    if (dy > 0.7 * bodyHeight && dy < 3 * bodyHeight) pitches.push(dy);
  }
  const pitch = pitches.length > 0 ? median(pitches) : 1.25 * bodyHeight;

  // Left margin of the body text (long lines only), used to detect first-line indents.
  const longLines = lines.filter((l) => l.chars >= 30);
  const baseX = median((longLines.length > 0 ? longLines : lines).map((l) => l.x));

  const blocks: ReflowBlock[] = [];
  let para: Line[] = [];
  let lastHeadingLine: Line | null = null;

  const flushParagraph = () => {
    if (para.length === 0) return;
    const text = joinLines(para.map((l) => l.text));
    if (text) blocks.push({ type: 'paragraph', text });
    para = [];
  };

  for (const line of lines) {
    const ratio = bodyHeight > 0 ? line.height / bodyHeight : 1;
    const isHeading =
      ratio >= HEADING_RATIO &&
      line.text.length <= HEADING_MAX_CHARS &&
      !/[,;]$/.test(line.text);

    if (isHeading) {
      flushParagraph();
      const last = blocks[blocks.length - 1];
      // Consecutive large lines are one multi-line heading.
      if (
        last?.type === 'heading' &&
        lastHeadingLine &&
        lastHeadingLine.y - line.y > 0 &&
        lastHeadingLine.y - line.y <= 1.6 * line.height
      ) {
        last.text = joinLines([last.text, line.text]);
      } else {
        blocks.push({ type: 'heading', level: headingLevel(ratio), text: joinLines([line.text]) });
      }
      lastHeadingLine = line;
      continue;
    }
    lastHeadingLine = null;

    const prev = para[para.length - 1];
    if (prev) {
      const gap = prev.y - line.y;
      const indented = line.x - baseX > 0.8 * bodyHeight;
      const startsNewParagraph =
        gap < 0 || // moved up: new column / block
        gap > PARAGRAPH_GAP_FACTOR * pitch ||
        (indented && SENTENCE_END.test(prev.text));
      if (startsNewParagraph) flushParagraph();
    }
    para.push(line);
  }
  flushParagraph();

  return blocks.filter((b) => b.text.length > 0);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Extracts one page as reflowable blocks. Resolves to `[]` when the page has no text layer
 * (typically a scanned image). Rejects with an `AbortError` when `signal` aborts.
 */
export async function extractReflowText(
  pdfDoc: ReflowDocument,
  pageNumber: number,
  signal?: AbortSignal
): Promise<ReflowBlock[]> {
  checkAborted(signal);
  const page = await pdfDoc.getPage(pageNumber);
  checkAborted(signal);
  const content = await page.getTextContent();
  checkAborted(signal);

  const lines = buildLines(content.items);
  if (lines.length === 0) return [];

  const cleaned = await dropPageFurniture(pdfDoc, pageNumber, lines, page.view, signal);
  checkAborted(signal);
  return linesToBlocks(cleaned);
}
