import type { Env } from '../types';
import { HttpError, assertSameOrigin, clientIp, errorResponse, isAdminRequest, rateLimit } from '../security';

/**
 * Runs before every /api/* handler:
 *  1. method allowlist,
 *  2. per-IP rate limiting (best effort, per isolate; pair it with a Cloudflare WAF rule),
 *  3. CSRF protection for state-changing methods (same-origin only, unless admin bearer token),
 *  4. uniform error handling that never leaks stack traces / SQL / upstream details,
 *  5. hardened response headers for API responses.
 */

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE']);

const API_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  // API responses are data, never documents: forbid any active content if one is opened directly.
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox"
};

/**
 * Separate buckets per route so one activity can't starve another (e.g. page-turn syncs must not
 * block cover loading). Limits are generous enough for a campus NAT sharing one IP; they exist to
 * stop floods, not normal use. Per-isolate and best effort — pair with a WAF rule for hard limits.
 */
function limitsFor(pathname: string, method: string): { bucket: string; limit: number; windowMs: number } {
  const write = method === 'POST' || method === 'DELETE';
  if (pathname.startsWith('/api/shelves')) {
    return write ? { bucket: 'shelves-w', limit: 120, windowMs: 60_000 } : { bucket: 'shelves-r', limit: 60, windowMs: 60_000 };
  }
  if (write) return { bucket: 'write', limit: 20, windowMs: 60_000 };
  if (pathname.startsWith('/api/pdf-proxy')) return { bucket: 'pdf', limit: 600, windowMs: 60_000 };
  if (pathname.startsWith('/api/search')) return { bucket: 'search', limit: 60, windowMs: 60_000 };
  return { bucket: 'read', limit: 300, windowMs: 60_000 };
}

function withSecurityHeaders(response: Response): Response {
  // Responses from fetch() / cache are immutable; clone headers into a fresh Response.
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(API_SECURITY_HEADERS)) headers.set(key, value);
  // Never let an upstream or a handler reintroduce these.
  headers.delete('Access-Control-Allow-Origin');
  headers.delete('Access-Control-Allow-Credentials');
  headers.delete('Set-Cookie');
  headers.delete('Server');
  headers.delete('X-Powered-By');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  try {
    if (method === 'OPTIONS') {
      // Same-origin app: no CORS preflight is ever needed, so none is granted.
      return withSecurityHeaders(new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, POST, DELETE' } }));
    }
    if (!ALLOWED_METHODS.has(method)) {
      return withSecurityHeaders(errorResponse(405, 'method_not_allowed'));
    }

    const admin = await isAdminRequest(request, env.ADMIN_TOKEN);

    if (!admin) {
      const { bucket, limit, windowMs } = limitsFor(url.pathname, method);
      const verdict = rateLimit(`${bucket}:${clientIp(request)}`, limit, windowMs);
      if (!verdict.ok) {
        const res = errorResponse(429, 'rate_limited', 'Demasiadas solicitudes. Intenta de nuevo en unos segundos.');
        res.headers.set('Retry-After', String(verdict.retryAfter));
        return withSecurityHeaders(res);
      }
      if (method === 'POST' || method === 'DELETE') assertSameOrigin(request);
    }

    // Long query strings are never legitimate here and are a cheap DoS / log-pollution vector.
    if (url.search.length > 4096) {
      return withSecurityHeaders(errorResponse(414, 'uri_too_long'));
    }

    const response = await context.next();
    return withSecurityHeaders(response);
  } catch (err) {
    if (err instanceof HttpError) {
      return withSecurityHeaders(errorResponse(err.status, err.code, err.message !== err.code ? err.message : undefined));
    }
    console.error('[api] unhandled error', url.pathname, err instanceof Error ? err.message : err);
    return withSecurityHeaders(errorResponse(500, 'internal_error', 'Ocurrió un error inesperado.'));
  }
};
