import type { PDFDocumentLoadingTask } from 'pdfjs-dist';

export type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * Lazily loads pdf.js (a separate ~440 kB chunk) exactly once and points it at the
 * same-origin worker (compatible with `script-src 'self'` / `worker-src 'self'`).
 * Nothing in the initial bundle may import `pdfjs-dist` at module level.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    // The worker URL is imported dynamically too: a static `?url` import would be hoisted into
    // the initial bundle and drag the whole pdfjs chunk into <link rel="modulepreload">.
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    ])
      .then(([mod, worker]) => {
        mod.GlobalWorkerOptions.workerSrc = worker.default;
        return mod;
      })
      .catch((err: unknown) => {
        // Allow a retry after a transient chunk-load failure.
        pdfjsPromise = null;
        throw err;
      });
  }
  return pdfjsPromise;
}

/**
 * Hardened, bandwidth-friendly options shared by every document we open:
 * - no eval / no XFA (strict CSP; `isEvalSupported` is a no-op in pdf.js 6 but kept
 *   so a downgrade can never re-enable it),
 * - byte-range streaming without eagerly downloading the whole file.
 */
const DOCUMENT_OPTIONS = {
  rangeChunkSize: 65536,
  disableAutoFetch: true,
  disableStream: false,
  enableXfa: false,
  isEvalSupported: false,
  // Same-origin runtime data copied by scripts/copy-pdfjs-assets.mjs (CSP-compatible).
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/'
};

/**
 * Opens a document through pdf.js. `keepOffline` (reader only — never thumbnails) asks the
 * service worker to keep a copy so the book can be reread without connection.
 */
export function openPdfDocument(
  pdfjs: PdfjsModule,
  url: string,
  options: { keepOffline?: boolean } = {}
): PDFDocumentLoadingTask {
  const task = pdfjs.getDocument({ ...DOCUMENT_OPTIONS, url } as Parameters<PdfjsModule['getDocument']>[0]);
  if (options.keepOffline) {
    task.promise
      .then(() => {
        navigator.serviceWorker?.controller?.postMessage({ type: 'keep-pdf-offline', url });
      })
      .catch(() => undefined);
  }
  return task;
}
