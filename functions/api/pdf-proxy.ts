import type { Env } from '../types';
import { errorResponse, fetchWithTimeout, json, politeUserAgent, safeHttpUrl } from '../security';

/**
 * Same-origin proxy that lets the in-app pdf.js reader open open-access PDFs inline
 * (no forced downloads, byte ranges, edge cache).
 *
 * Hardening:
 *  - only allowlisted academic hosts, validated again on EVERY redirect hop (no open proxy / SSRF),
 *  - only `application/pdf` (or raster images for covers) is ever returned — never HTML, SVG or JS,
 *    so the proxy cannot be abused to host phishing pages or scripts on the coleebri origin,
 *  - strict size cap, timeouts and a hop limit,
 *  - upstream headers are NOT passed through except a small safe set.
 */

const MAX_CACHEABLE_BYTES = 25 * 1024 * 1024;
const MAX_PROXY_BYTES = 120 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_LANDING_HTML_BYTES = 2 * 1024 * 1024;
const CACHE_NAME = 'coleebri-pdf-v2';

const ALLOWED_IMAGE_TYPES = /^image\/(?:jpeg|png|webp|gif|avif)$/;

type FetchedTarget = { response: Response; finalUrl: URL };

/** Follows redirects manually, re-validating each Location against the allowlist. */
async function fetchAllowlisted(
  start: URL,
  init: { method: string; headers: Headers },
  timeoutMs = 20_000
): Promise<FetchedTarget | null> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchWithTimeout(current.toString(), { ...init, redirect: 'manual' }, timeoutMs, true);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) return null;
      let next: URL | null = null;
      try {
        next = safeHttpUrl(new URL(location, current).toString());
      } catch {
        next = null;
      }
      if (!next) return null; // redirect left the trusted academic network
      current = next;
      continue;
    }
    return { response, finalUrl: current };
  }
  return null;
}

/** TransformStream that errors once more than `maxBytes` have flowed through it. */
function byteLimiter(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(new Error('document_too_large'));
        return;
      }
      controller.enqueue(chunk);
    }
  });
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (received >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return text + decoder.decode();
}

function extractEmbeddedPdfUrl(html: string, baseUrl: URL): URL | null {
  const candidates = [
    /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1],
    /<meta[^>]+content=["']([^"']+\.pdf[^"']*)["'][^>]+name=["']citation_pdf_url["']/i.exec(html)?.[1],
    /href=["']([^"']*\/pdf\/[^"']+\.pdf[^"']*)["']/i.exec(html)?.[1],
    /href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/i.exec(html)?.[1]
  ].filter((v): v is string => Boolean(v));

  for (const candidate of candidates) {
    try {
      const decoded = candidate.replace(/&amp;/g, '&');
      const valid = safeHttpUrl(new URL(decoded, baseUrl).toString());
      if (valid && valid.hostname !== 'doi.org') return valid;
    } catch {
      // ignore malformed candidate
    }
  }
  return null;
}

function parseByteRange(rangeHeader: string, totalLength: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number.parseInt(match[1], 10) : 0;
  let end = match[2] ? Number.parseInt(match[2], 10) : totalLength - 1;
  if (!match[1] && match[2]) {
    start = Math.max(0, totalLength - Number.parseInt(match[2], 10));
    end = totalLength - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || start >= totalLength) return null;
  return { start, end: Math.min(end, totalLength - 1) };
}

/** Builds response headers from scratch: only a safe, explicit subset of upstream metadata is kept. */
function buildHeaders(upstream: Headers, contentType: string, extra: Record<string, string> = {}): Headers {
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('Content-Disposition', 'inline'); // never force a download
  for (const key of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const value = upstream.get(key);
    if (value) headers.set(key, value);
  }
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return headers;
}

function classifyContentType(raw: string | null): 'pdf' | 'image' | 'html' | 'other' {
  const type = (raw || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/pdf' || type === 'application/x-pdf') return 'pdf';
  if (ALLOWED_IMAGE_TYPES.test(type)) return 'image';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  // Some SciELO mirrors label PDFs as octet-stream; accept them only as PDF (pdf.js validates the bytes).
  if (type === 'application/octet-stream' || type === 'binary/octet-stream') return 'pdf';
  return 'other';
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'method_not_allowed');
  }

  const reqUrl = new URL(request.url);
  const targetUrl = safeHttpUrl(reqUrl.searchParams.get('url'));
  if (!targetUrl) {
    return json(
      { error: 'disallowed_origin', message: 'Solo se permiten dominios académicos verificados de SciELO y Acceso Abierto.' },
      403
    );
  }

  const cache = await caches.open(CACHE_NAME);
  const cacheKey = new Request(`${reqUrl.origin}/__pdf_cache?url=${encodeURIComponent(targetUrl.toString())}`, {
    method: 'GET'
  });
  const rangeHeader = request.headers.get('Range');
  const validRangeSyntax = !rangeHeader || /^bytes=\d*-\d*$/i.test(rangeHeader.trim());
  if (!validRangeSyntax) return errorResponse(416, 'invalid_range');

  try {
    // 1. Edge cache (only full 200 responses of validated content are stored)
    const cached = await cache.match(cacheKey);
    if (cached) {
      const contentType = cached.headers.get('content-type') || 'application/pdf';
      if (request.method === 'HEAD') {
        await cached.body?.cancel().catch(() => undefined);
        return new Response(null, { status: 200, headers: buildHeaders(cached.headers, contentType, { 'X-Edge-Cache': 'HIT' }) });
      }
      if (rangeHeader) {
        const buf = await cached.arrayBuffer();
        const range = parseByteRange(rangeHeader, buf.byteLength);
        if (!range) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buf.byteLength}` } });
        }
        const slice = buf.slice(range.start, range.end + 1);
        return new Response(slice, {
          status: 206,
          headers: buildHeaders(cached.headers, contentType, {
            'Content-Range': `bytes ${range.start}-${range.end}/${buf.byteLength}`,
            'Content-Length': String(slice.byteLength),
            'X-Edge-Cache': 'HIT-RANGE'
          })
        });
      }
      return new Response(cached.body, { status: 200, headers: buildHeaders(cached.headers, contentType, { 'X-Edge-Cache': 'HIT' }) });
    }

    // 2. Upstream fetch with per-hop validation
    const upstreamHeaders = new Headers({
      'User-Agent': politeUserAgent(env.CONTACT_EMAIL),
      Accept: 'application/pdf,image/avif,image/webp,image/jpeg,image/png;q=0.9,text/html;q=0.5',
      'Accept-Encoding': 'identity'
    });
    if (rangeHeader && request.method === 'GET') upstreamHeaders.set('Range', rangeHeader);

    let fetched = await fetchAllowlisted(targetUrl, { method: request.method, headers: upstreamHeaders });
    if (!fetched) return errorResponse(502, 'redirect_outside_allowlist', 'El enlace redirige fuera de la red académica permitida.');

    let kind = classifyContentType(fetched.response.headers.get('content-type'));

    // DOI / landing page → discover the embedded PDF (citation_pdf_url) and fetch it instead
    if (kind === 'html' && fetched.response.ok) {
      const html = await readLimitedText(fetched.response, MAX_LANDING_HTML_BYTES);
      const embedded = extractEmbeddedPdfUrl(html, fetched.finalUrl);
      if (!embedded) {
        return errorResponse(422, 'no_pdf_available', 'Esta obra no ofrece un PDF de texto completo accesible.');
      }
      const landingHost = fetched.finalUrl.hostname;
      const pdfHeaders = new Headers(upstreamHeaders);
      const next = await fetchAllowlisted(embedded, { method: request.method, headers: pdfHeaders });
      if (!next) return errorResponse(502, 'redirect_outside_allowlist');
      fetched = next;
      kind = classifyContentType(fetched.response.headers.get('content-type'));

      // Lazy write-back: remember the real PDF so the next visitor skips the DOI/landing hop.
      // Only the server writes here, only allowlisted URLs, only rows that have no PDF yet.
      // Guards: same-site request only (no cross-site <img>/<link> triggering writes), the PDF
      // must live on the same host as the landing page that linked it, and it must be the
      // final URL actually served (no redirect elsewhere).
      const fetchSite = request.headers.get('sec-fetch-site');
      const sameSite = !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
      if (
        env.DB &&
        sameSite &&
        kind === 'pdf' &&
        fetched.response.ok &&
        embedded.hostname === landingHost &&
        fetched.finalUrl.toString() === embedded.toString()
      ) {
        const resolvedPdf = embedded.toString();
        const doi = targetUrl.hostname === 'doi.org' ? decodeURIComponent(targetUrl.pathname.slice(1)) : '';
        context.waitUntil(
          env.DB.prepare(
            `UPDATE publications SET pdf_url = ?, updated_at = datetime('now')
             WHERE (pdf_url IS NULL OR pdf_url = '') AND (scielo_url = ? OR (? != '' AND doi = ?))`
          )
            .bind(resolvedPdf, targetUrl.toString(), doi, doi)
            .run()
            .catch(() => undefined)
        );
      }
    }

    const upstream = fetched.response;
    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => undefined);
      if (upstream.status === 416) return errorResponse(416, 'range_not_satisfiable');
      return errorResponse(upstream.status === 404 ? 404 : 502, 'upstream_unavailable', 'El servidor de origen no respondió con el documento.');
    }

    if (kind !== 'pdf' && kind !== 'image') {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(502, 'unsupported_upstream_content', 'El origen devolvió un formato no permitido.');
    }

    const contentLength = Number.parseInt(upstream.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_PROXY_BYTES) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(413, 'document_too_large');
    }

    const contentType = kind === 'pdf' ? 'application/pdf' : (upstream.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const responseHeaders = buildHeaders(upstream.headers, contentType, {
      'X-Edge-Cache': upstream.status === 206 ? 'BYPASS-RANGE' : 'MISS'
    });

    if (request.method === 'HEAD') {
      await upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }

    if (!upstream.body) return new Response(null, { status: upstream.status, headers: responseHeaders });

    // SciELO Books' CDN streams PDFs chunked (no Content-Length, Range ignored): enforce the
    // byte cap while streaming instead of trusting the declared length.
    const clientBody = upstream.body.pipeThrough(byteLimiter(MAX_PROXY_BYTES));

    if (upstream.status === 200 && (contentLength === 0 || contentLength <= MAX_CACHEABLE_BYTES)) {
      const [clientStream, cacheStream] = clientBody.tee();
      // If the document turns out larger than the cache cap, the limited stream errors and
      // cache.put() rejects — nothing partial is ever cached.
      const toCache = new Response(cacheStream.pipeThrough(byteLimiter(MAX_CACHEABLE_BYTES)), {
        status: 200,
        headers: buildHeaders(upstream.headers, contentType)
      });
      context.waitUntil(cache.put(cacheKey, toCache).catch(() => undefined));
      return new Response(clientStream, { status: 200, headers: responseHeaders });
    }

    return new Response(clientBody, { status: upstream.status, headers: responseHeaders });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    console.error('[pdf-proxy]', targetUrl.hostname, err instanceof Error ? err.message : err);
    return errorResponse(timeout ? 504 : 502, timeout ? 'upstream_timeout' : 'proxy_fetch_failed', 'No se pudo obtener el documento.');
  }
};
