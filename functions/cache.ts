/**
 * Edge caching for anonymous, read-only API responses.
 *
 * Why: D1 bills by rows read and the free plan allows 5M/day. Facet counts and the default
 * listing are identical for every visitor, so they are computed at most once per TTL per
 * Cloudflare location instead of on every page view.
 *
 * Uses a NAMED cache: on *.pages.dev, `caches.default` ignores custom keys.
 */

const CACHE_NAME = 'coleebri-api-v1';

/** Builds a stable same-origin cache key: path + sorted query params (minus ignored ones). */
export function cacheKeyFor(request: Request, namespace: string, ignore: string[] = []): Request {
  const url = new URL(request.url);
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !ignore.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const normalized = new URLSearchParams(params).toString();
  return new Request(`${url.origin}/__cache/${namespace}?${normalized}`, { method: 'GET' });
}

/**
 * Returns the cached JSON for `key` or computes it with `produce`, storing it for `ttlSeconds`.
 * Failures to read/write the cache never break the request.
 */
export async function cachedJson<T>(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  key: Request,
  ttlSeconds: number,
  produce: () => Promise<T>
): Promise<{ data: T; hit: boolean }> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(key);
    if (hit) return { data: (await hit.json()) as T, hit: true };
  } catch {
    cache = null;
  }
  const data = await produce();
  if (cache) {
    const response = new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttlSeconds}` }
    });
    ctx.waitUntil(cache.put(key, response).catch(() => undefined));
  }
  return { data, hit: false };
}
