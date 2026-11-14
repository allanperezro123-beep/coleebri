/* Coleebri service worker: lightweight offline support.
 *
 *  - navigations:   network-first (4 s timeout) -> cached /index.html
 *  - /assets/*:     cache-first (hashed, immutable)
 *  - /api/pdf-proxy: network first; a document is stored for offline reading ONLY when the
 *    reader asks for it (postMessage {type:'keep-pdf-offline', url}) — never for thumbnails —
 *    and only if it is a 200 application/pdf of at most 25 MB (measured, not trusted). Last 12.
 *  - everything else (any other /api/*, non-GET, non-200, opaque, Range/206) is NEVER cached.
 */
const VERSION = 'v2';
const SHELL_CACHE = 'coleebri-shell-' + VERSION;
const ASSET_CACHE = 'coleebri-assets-' + VERSION;
const PDF_CACHE = 'coleebri-pdf-' + VERSION;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE, PDF_CACHE];
const MAX_PDF_DOCS = 12;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const NAVIGATION_TIMEOUT_MS = 4000;

const pendingPdfPrefetch = new Set();
const ASSET_TYPES = /^(?:text\/css|(?:application|text)\/javascript|font\/|image\/|application\/(?:font|wasm|json|manifest))/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Best effort: a failed precache must not prevent the worker from installing.
      await Promise.all(['/', '/index.html'].map((url) => cache.add(url).catch(() => undefined)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('coleebri-') && !CURRENT_CACHES.includes(name))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (url.pathname === '/api/pdf-proxy') {
    const range = request.headers.get('range');
    if (range) {
      event.respondWith(handlePdfRange(event, request, range));
    } else {
      event.respondWith(handlePdfFull(event, request));
    }
  }
  // any other request: untouched (network only)
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
    const url = new URL(request.url);
    const isShell = url.pathname === '/' || url.pathname === '/index.html';
    const isHtml = (response.headers.get('content-type') || '').includes('text/html');
    if (isShell && response.ok && response.status === 200 && response.type === 'basic' && isHtml) {
      cache.put('/index.html', response.clone()).catch(() => undefined);
    }
    return response;
  } catch (error) {
    const cached = (await cache.match('/index.html')) || (await cache.match('/'));
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Never store the SPA fallback HTML under an /assets/ URL (stale chunk after a deploy).
  const type = response.headers.get('content-type') || '';
  if (response.ok && response.status === 200 && response.type === 'basic' && ASSET_TYPES.test(type)) {
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

function isPdfResponse(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('application/pdf')) return false;
  const declared = Number(response.headers.get('content-length'));
  return !(Number.isFinite(declared) && declared > MAX_PDF_BYTES);
}

/** Stores a full PDF, enforcing the size cap on the real bytes (SciELO often omits Content-Length). */
async function storePdf(request, response) {
  const blob = await response.blob();
  if (blob.size === 0 || blob.size > MAX_PDF_BYTES) return;
  const cache = await caches.open(PDF_CACHE);
  // delete + put keeps insertion order == recency order
  await cache.delete(request);
  await cache.put(
    request,
    new Response(blob, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(blob.size) } })
  );
  const keys = await cache.keys();
  const excess = keys.length - MAX_PDF_DOCS;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

function samePdfProxyUrl(raw) {
  try {
    const url = new URL(raw, self.location.origin);
    return url.origin === self.location.origin && url.pathname === '/api/pdf-proxy' ? url.toString() : null;
  } catch {
    return null;
  }
}

// The reader asks explicitly to keep the open book for offline rereading.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'keep-pdf-offline') return;
  const url = samePdfProxyUrl(data.url);
  if (!url || pendingPdfPrefetch.has(url)) return;
  pendingPdfPrefetch.add(url);
  const request = new Request(url);
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PDF_CACHE);
      if (await cache.match(request)) return;
      const full = await fetch(request);
      if (isPdfResponse(full)) await storePdf(request, full);
      else if (full.body) await full.body.cancel();
    })()
      .catch(() => undefined)
      .finally(() => pendingPdfPrefetch.delete(url))
  );
});

/** Full-document GET: network first, cached copy only as offline fallback. */
async function handlePdfFull(event, request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await (await caches.open(PDF_CACHE)).match(request);
    if (cached) return cached;
    throw error;
  }
}

/** Range requests go to the network untouched; offline, the range is sliced from a kept copy. */
async function handlePdfRange(event, request, rangeHeader) {
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await (await caches.open(PDF_CACHE)).match(new Request(request.url));
    if (!cached) throw error;
    return sliceCachedPdf(cached, rangeHeader);
  }
}

async function sliceCachedPdf(cached, rangeHeader) {
  const blob = await cached.blob();
  const size = blob.size;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return new Response(blob, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  let start = match[1] === '' ? NaN : Number(match[1]);
  let end = match[2] === '' ? NaN : Number(match[2]);
  if (Number.isNaN(start)) {
    // suffix range: last N bytes
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end) || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}
