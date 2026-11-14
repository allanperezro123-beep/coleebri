/**
 * Polite HTTP layer for the harvester.
 *
 *  - Exponential backoff 1-2-4-8-16 s (+ jitter) on 429 / 5xx / network errors, honours Retry-After.
 *  - Per-host minimum spacing between request starts (Crossref, OpenAlex, books.scielo.org ...).
 *  - TLS verification is NEVER disabled: certificate errors are fatal for that source (TlsError).
 *  - No e-mail is ever sent to third parties. An optional contact (env HARVEST_CONTACT_EMAIL) is the
 *    only thing that may be appended to the User-Agent, and only if the operator sets it explicitly.
 */

const CONTACT = (process.env.HARVEST_CONTACT_EMAIL || '').trim();
export const USER_AGENT =
  'Coleebri-Harvester/2.1 (+https://coleebri.pages.dev)' +
  (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(CONTACT) ? ` (mailto:${CONTACT})` : '');

/** Minimum milliseconds between two request STARTS to the same host. */
const HOST_DELAY_MS: Array<[RegExp, number]> = [
  [/^api\.crossref\.org$/, 250],
  [/^api\.openalex\.org$/, 150],
  [/(^|\.)scielo\.org$/, 1000], // books.scielo.org, static.scielo.org
  [/^doi\.org$/, 200]
];
const DEFAULT_DELAY_MS = 400;

const nextSlot = new Map<string, number>();

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function delayFor(host: string): number {
  for (const [pattern, ms] of HOST_DELAY_MS) if (pattern.test(host)) return ms;
  return DEFAULT_DELAY_MS;
}

/** Reserves the next start slot for a host (synchronously, so concurrent callers get staggered). */
async function waitForHostSlot(host: string): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, start + delayFor(host));
  if (start > now) await sleep(start - now);
}

export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/** Upstream says "come back much later" (daily budget exhausted). Callers stop the source gracefully. */
export class QuotaError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSec: number
  ) {
    super(message);
  }
}

/** TLS/certificate failure. Never retried and never bypassed. */
export class TlsError extends Error {}

const TLS_CODES = /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|EPROTO)/;

function errorCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string; cause?: { code?: string } } };
  return e?.cause?.code || e?.cause?.cause?.code || e?.code || '';
}

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  redirect?: RequestRedirect;
  /** Max retries (default 5 => waits of 1,2,4,8,16 s). */
  maxRetries?: number;
  /** A 429 asking for longer than this (seconds) is treated as an exhausted quota. Default 90. */
  maxRetryAfterSec?: number;
}

export const stats = { requests: 0, retries: 0, failures: 0 };

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1000);
  return null;
}

/**
 * fetch with retries. Returns the Response for any non-retryable status (2xx, 3xx, 4xx other than 429) —
 * the caller inspects `res.ok`. Throws HttpStatusError / QuotaError / TlsError / network errors otherwise.
 */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 30_000, maxRetries = 5, maxRetryAfterSec = 90 } = opts;
  const host = new URL(url).hostname.toLowerCase();
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await waitForHostSlot(host);
    stats.requests += 1;
    let retryAfterMs: number | null = null;
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        redirect: opts.redirect ?? 'follow',
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...opts.headers },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 429 && retryAfter !== null && retryAfter > maxRetryAfterSec) {
          throw new QuotaError(`HTTP 429 from ${host}; Retry-After ${Math.round(retryAfter)}s`, retryAfter);
        }
        lastError = new HttpStatusError(res.status, url);
        retryAfterMs = retryAfter !== null ? retryAfter * 1000 : null;
      } else {
        return res;
      }
    } catch (err) {
      if (err instanceof QuotaError) throw err;
      const code = errorCode(err);
      if (TLS_CODES.test(code)) throw new TlsError(`TLS verification failed for ${host} (${code}). Not retrying; TLS is never bypassed.`);
      lastError = err;
    }

    if (attempt === maxRetries) break;
    stats.retries += 1;
    const backoff = 1000 * 2 ** attempt + Math.floor(Math.random() * 500);
    await sleep(Math.max(backoff, retryAfterMs ?? 0));
  }
  stats.failures += 1;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Runs `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
