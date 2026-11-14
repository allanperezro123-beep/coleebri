/**
 * Pdf helpers that DO NOT import pdfjs-dist.
 *
 * pdf.js weighs ~440 kB; it must only be fetched when somebody actually needs it
 * (a card near the viewport rendering page 1, or the reader). Loading + worker
 * configuration live in `pdfLoader.ts` (dynamic import). Everything here is
 * safe to import from the initial bundle.
 */

/** Same-origin proxy URL for a remote PDF (range requests, inline disposition). */
export function buildPdfProxyUrl(rawUrl: string): string {
  const clean = rawUrl.replace(/^http:\/\//i, 'https://');
  return `/api/pdf-proxy?url=${encodeURIComponent(clean)}`;
}

/** Same-origin proxy URL for a remote raster cover image. */
export function buildCoverProxyUrl(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  const clean = rawUrl.replace(/^http:\/\//i, 'https://');
  return `/api/pdf-proxy?url=${encodeURIComponent(clean)}`;
}

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { name?: string }).name === 'AbortError' ||
      (err as { name?: string }).name === 'AbortException')
  );
}

/**
 * Tiny concurrency limiter. Tasks wait in FIFO order; a task that is aborted
 * while still queued is dropped without ever running.
 */
export class ConcurrencyQueue {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent = 2) {}

  enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }

      const queue = this.queue;

      const onAbort = () => {
        const idx = queue.indexOf(start);
        if (idx >= 0) {
          queue.splice(idx, 1);
          reject(abortError());
        }
      };

      const start = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        void (async () => task())()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.drain();
          });
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(start);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      this.queue.shift()?.();
    }
  }
}

/** Card thumbnails (page 1 renders) — at most 2 at a time, app-wide. */
export const pdfThumbnailQueue = new ConcurrencyQueue(2);

/* ------------------------------------------------------------------ */
/* Proxy error classification                                          */
/* ------------------------------------------------------------------ */

export type PdfErrorKind =
  | 'disallowed_origin'
  | 'no_pdf_available'
  | 'rate_limited'
  | 'redirect_outside_allowlist'
  | 'upstream_unavailable'
  | 'unsupported_upstream_content'
  | 'upstream_timeout'
  | 'invalid_pdf'
  | 'network'
  | 'unknown';

export interface PdfErrorInfo {
  kind: PdfErrorKind;
  /** Whether trying again may help (transient failures). */
  retryable: boolean;
  /** Spanish, user-facing, free of infrastructure jargon. */
  message: string;
}

const ERROR_COPY: Record<PdfErrorKind, { message: string; retryable: boolean }> = {
  disallowed_origin: {
    message:
      'Este documento está alojado fuera de las fuentes académicas verificadas, por eso no se puede abrir aquí.',
    retryable: false
  },
  no_pdf_available: {
    message: 'Esta obra no ofrece un PDF de texto completo al que Coleebri pueda acceder.',
    retryable: false
  },
  rate_limited: {
    message: 'Hay muchas solicitudes en este momento. Espera unos segundos e inténtalo de nuevo.',
    retryable: true
  },
  redirect_outside_allowlist: {
    message: 'El enlace de esta obra lleva a un sitio que no está entre las fuentes académicas verificadas.',
    retryable: false
  },
  upstream_unavailable: {
    message: 'La fuente original no entregó el documento. Puede estar en mantenimiento; inténtalo más tarde.',
    retryable: true
  },
  unsupported_upstream_content: {
    message: 'La fuente original devolvió un formato que el lector no puede mostrar.',
    retryable: false
  },
  upstream_timeout: {
    message: 'La fuente original tardó demasiado en responder. Inténtalo de nuevo en un momento.',
    retryable: true
  },
  invalid_pdf: {
    message: 'El archivo recibido no es un PDF válido o está dañado.',
    retryable: false
  },
  network: {
    message: 'No hay conexión. Revisa tu red e inténtalo de nuevo.',
    retryable: true
  },
  unknown: {
    message: 'No fue posible abrir el documento.',
    retryable: true
  }
};

/** Builds the user-facing description for a known error kind. */
export function pdfErrorInfo(kind: PdfErrorKind): PdfErrorInfo {
  return { kind, ...ERROR_COPY[kind] };
}

const info = pdfErrorInfo;

const KNOWN_PROXY_CODES = new Set<string>([
  'disallowed_origin',
  'no_pdf_available',
  'rate_limited',
  'redirect_outside_allowlist',
  'upstream_unavailable',
  'unsupported_upstream_content',
  'upstream_timeout'
]);

/**
 * Asks the proxy for its JSON error code (a 1-byte range request is enough: the
 * error body is produced before any upstream bytes are streamed). Never throws.
 */
async function probeProxyErrorCode(proxyUrl: string): Promise<string | null> {
  try {
    const res = await fetch(proxyUrl, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok || res.status === 206) {
      void res.body?.cancel();
      return null;
    }
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('json')) return null;
    const body: unknown = await res.json();
    const code = (body as { error?: unknown })?.error;
    return typeof code === 'string' && KNOWN_PROXY_CODES.has(code) ? code : null;
  } catch {
    return null;
  }
}

function statusToKind(status: number): PdfErrorKind {
  if (status === 403) return 'disallowed_origin';
  if (status === 422) return 'no_pdf_available';
  if (status === 429) return 'rate_limited';
  if (status === 504) return 'upstream_timeout';
  if (status === 404 || status >= 500) return 'upstream_unavailable';
  return 'unknown';
}

/**
 * Maps a pdf.js loading error (HTTP status carried by `ResponseException` /
 * `UnexpectedResponseException`) to a precise Spanish message. For a generic
 * 502 it asks the proxy which of its three 502 codes it was.
 */
export async function classifyPdfError(err: unknown, proxyUrl?: string): Promise<PdfErrorInfo> {
  const e = err as { name?: string; status?: number; message?: string } | null;
  const name = e?.name ?? '';

  if (name === 'InvalidPDFException' || name === 'FormatError') return info('invalid_pdf');

  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (status !== undefined && status > 0) {
    let kind = statusToKind(status);
    if (kind === 'upstream_unavailable' && proxyUrl) {
      const code = await probeProxyErrorCode(proxyUrl);
      if (code && code in ERROR_COPY) kind = code as PdfErrorKind;
    }
    return info(kind);
  }

  if (name === 'TypeError' || /network|failed to fetch|load failed/i.test(e?.message ?? '')) {
    return info('network');
  }
  return info('unknown');
}
