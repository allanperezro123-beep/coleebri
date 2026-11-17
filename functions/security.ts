/**
 * Shared security primitives for Coleebri Pages Functions.
 *
 * Coleebri has no user accounts by design ("cero fricción"), so the threat model is:
 *  - anonymous visitors must never be able to write the public catalog (admin token only),
 *  - private data (shelves/notes) is scoped by an unguessable per-device owner key,
 *  - every endpoint is same-origin only (no wildcard CORS), bounded in size and rate,
 *  - upstream fetches are allowlisted, time-boxed and never echo internal errors.
 */

export const MAX_QUERY_LENGTH = 200;
export const MAX_FILTER_VALUES = 10;
export const MAX_FILTER_VALUE_LENGTH = 64;

/** Hosts whose URLs may be stored in D1 / rendered as links or fetched by the PDF proxy. */
export const TRUSTED_CONTENT_HOST =
  /^(?:(?:[a-z0-9-]+\.)*(?:scielo\.(?:org|br|cl|pt|edu\.uy|sa\.cr|sld\.cu|isciii\.es)|scielo\.org\.(?:ar|bo|co|ec|mx|pe|py|ve)|scielo\.iics\.una\.py|doabooks\.org|oapen\.org|doi\.org|archive\.org)|ariadnaediciones\.cl|assets\.verlag\.gta\.arch\.ethz\.ch|ciencialatina\.org|d-nb\.info|die\.udistrital\.edu\.co|downloads\.editoracientifica\.com\.br|e-archivo\.uc3m\.es|editorial\.ucatolicaluisamigo\.edu\.co|editorialmarcaribe\.es|edizionicafoscari\.unive\.it|eladd\.org|intech-files\.s3\.amazonaws\.com|libros\.unad\.edu\.co|libros\.univalle\.edu\.co|melusina-pubs\.fra1\.digitaloceanspaces\.com|mts\.intechopen\.com|ora\.ox\.ac\.uk|portalcris\.vdu\.lt|pure\.iiasa\.ac\.at|real\.mtak\.hu|repository\.unad\.edu\.co|repository\.uniminuto\.edu|researchonline\.lse\.ac\.uk|revistas\.upsa\.es|revistasonline\.inap\.es|sauyayinlari\.sakarya\.edu\.tr|skyfox\.co|sophiaeditions\.com|www\.berghahnbooks\.com|www\.cambridge\.org|www\.editoracientifica\.com\.br|www\.editoracrv\.com\.br|www\.ledizioni\.it|www\.logos-verlag\.de|www\.marxists\.org|www\.redalyc\.org|www\.sav\.sk|www\.seankingston\.co\.uk|www\.vdu\.lt|www\.viella\.it|www\.zaphon\.de)$/i;

const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string
  ) {
    super(message ?? code);
  }
}

/** JSON response for API routes. Same-origin only: no Access-Control-Allow-Origin is ever emitted. */
export function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

export function errorResponse(status: number, code: string, message?: string): Response {
  return json({ error: code, ...(message ? { message } : {}) }, status);
}

/**
 * Parses and validates an absolute http(s) URL. Rejects credentials, IP literals,
 * non-default ports and (optionally) hosts outside an allowlist. HTTP is upgraded to HTTPS.
 */
export function safeHttpUrl(raw: unknown, allowHost: RegExp | null = TRUSTED_CONTENT_HOST): URL | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== '443' && parsed.port !== '80') return null;
  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || IP_LITERAL.test(host)) return null;
  if (allowHost && !allowHost.test(host)) return null;
  parsed.protocol = 'https:';
  parsed.port = '';
  parsed.hash = '';
  return parsed;
}

/** Same as safeHttpUrl but returns a string (or undefined) — convenient when sanitizing records. */
export function safeUrlString(raw: unknown, allowHost: RegExp | null = TRUSTED_CONTENT_HOST): string | undefined {
  return safeHttpUrl(raw, allowHost)?.toString();
}

/** Lowercases and strips diacritics: "Educación" → "educacion" (SQLite LIKE can't do this). */
export function foldText(input: string): string {
  return input.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Truncates a string so its UTF-8 encoding is at most `maxBytes` (never splits a code point). */
export function truncateUtf8(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let out = '';
  let bytes = 0;
  for (const ch of input) {
    const size = encoder.encode(ch).byteLength;
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/**
 * Splits a query into at most 4 folded words, each bounded so that `%word%` (after escaping)
 * stays below D1's 50-byte LIKE pattern limit.
 */
export function searchWords(q: string): string[] {
  return foldText(q)
    .split(/\s+/)
    .map((w) => truncateUtf8(w.replace(/[\\%_]/g, ''), 40))
    .filter((w) => w.length >= 2)
    .slice(0, 4);
}

/**
 * Builds a safe FTS5 MATCH expression: every word becomes a quoted prefix token ("educa"*),
 * implicitly AND-ed. Only letters/digits survive, so FTS5 operators (OR, NEAR, -, :, ^, ())
 * typed by users can never change the query shape. Returns null when nothing is searchable.
 */
export function ftsMatchQuery(q: string): string | null {
  const tokens = foldText(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 6)
    .map((t) => `"${truncateUtf8(t, 40)}"*`);
  return tokens.length > 0 ? tokens.join(' ') : null;
}

/** True when the error means the FTS index isn't installed yet (migration 0006 pending). */
export function isMissingFtsError(err: unknown): boolean {
  return err instanceof Error && /no such table: publications_fts|no such module: fts5/i.test(err.message);
}

/** Folded text blob stored in `publications.search_text` for accent-insensitive search. */
export function buildSearchText(p: {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  abstract?: string;
  keywords?: string[];
  doi?: string;
  isbn?: string;
}): string {
  return foldText(
    [p.title, p.subtitle, (p.authors || []).join(' '), p.publisher, (p.keywords || []).join(' '), p.doi, p.isbn, (p.abstract || '').slice(0, 1500)]
      .filter(Boolean)
      .join(' ')
  ).slice(0, 4000);
}

/**
 * SQL fragment for one search word: uses the folded `search_text` column when present and
 * falls back to raw LIKE on the main columns for rows not indexed yet. Binds 1 + 4 params.
 */
export const SEARCH_WORD_CLAUSE =
  "(search_text LIKE ? ESCAPE '\\' OR (search_text IS NULL AND (title LIKE ? ESCAPE '\\' OR authors_json LIKE ? ESCAPE '\\' OR publisher LIKE ? ESCAPE '\\' OR doi LIKE ? ESCAPE '\\')))";

export function searchWordParams(word: string): string[] {
  const like = `%${escapeLike(word)}%`;
  return [like, like, like, like, like];
}

/** Escapes LIKE wildcards so user input is matched literally (use with `ESCAPE '\\'`). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Splits a comma separated filter param into a bounded list of short tokens. */
export function parseListParam(value: string | null, allowed?: ReadonlySet<string>): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const token = raw.trim();
    if (!token || token.length > MAX_FILTER_VALUE_LENGTH) continue;
    if (allowed && !allowed.has(token)) continue;
    if (!out.includes(token)) out.push(token);
    if (out.length >= MAX_FILTER_VALUES) break;
  }
  return out;
}

export function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Trims, strips control characters and bounds the length of untrusted text. */
export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}

/** Reads a JSON body with a hard byte limit and content-type check. */
export async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T> {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Se esperaba application/json.');
  }
  const declared = Number.parseInt(request.headers.get('content-length') || '0', 10);
  if (declared > maxBytes) throw new HttpError(413, 'payload_too_large');

  if (!request.body) throw new HttpError(400, 'empty_body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'payload_too_large');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged)) as T;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two secrets (compares SHA-256 digests to hide length). */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i += 1) diff |= da.charCodeAt(i) ^ db.charCodeAt(i);
  return diff === 0;
}

/** Admin-only operations (catalog writes, harvesting) require `Authorization: Bearer <ADMIN_TOKEN>`. */
export async function isAdminRequest(request: Request, adminToken: string | undefined): Promise<boolean> {
  if (!adminToken || adminToken.length < 24) return false;
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return secretsEqual(match[1].trim(), adminToken);
}

/** Owner keys are 32+ char base64url strings generated in the browser (crypto.getRandomValues). */
const OWNER_KEY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export async function resolveOwnerHash(request: Request): Promise<string> {
  const key = request.headers.get('x-coleebri-owner') || '';
  if (!OWNER_KEY_PATTERN.test(key)) {
    throw new HttpError(401, 'missing_owner_key', 'Falta la llave anónima del dispositivo.');
  }
  return sha256Hex(`coleebri-owner:v1:${key}`);
}

/**
 * Rejects cross-site state-changing requests (CSRF). Browsers always send Origin on
 * POST/DELETE; requests from other sites (or other origins) are refused.
 */
export function assertSameOrigin(request: Request): void {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (origin && origin !== requestOrigin) throw new HttpError(403, 'cross_origin_forbidden');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpError(403, 'cross_site_forbidden');
  }
}

/* ------------------------------------------------------------------ */
/* Best-effort per-isolate rate limiter (sliding window).              */
/* For hard guarantees add a Cloudflare WAF rate-limiting rule as well. */
/* ------------------------------------------------------------------ */

const buckets = new Map<string, number[]>();
let lastSweep = 0;

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, hits] of buckets) {
      if (hits.length === 0 || now - hits[hits.length - 1] > 10 * 60_000) buckets.delete(k);
    }
    if (buckets.size > 20_000) buckets.clear();
  }
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000)) };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { ok: true, retryAfter: 0 };
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
}

/**
 * fetch() with a timeout; never follows redirects implicitly unless asked.
 * Set `headersOnly = true` for streaming downloads so large PDFs aren't killed mid-body.
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
  headersOnly = false
): Promise<Response> {
  if (!headersOnly) {
    return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    timeoutMs
  );
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** User-Agent for outbound polite requests. Contact e-mail is optional and comes from env, never hardcoded. */
export function politeUserAgent(contactEmail?: string): string {
  const contact = contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) ? ` (mailto:${contactEmail})` : '';
  return `Coleebri/2.1 (+https://coleebri.pages.dev)${contact}`;
}
