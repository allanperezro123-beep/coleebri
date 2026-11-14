/** Cheap PDF verification: GET and read only the first 5 bytes (== "%PDF-"). Never downloads a whole PDF. */
import { fetchWithRetry, mapPool } from './http';

export interface PdfCheck {
  url: string;
  ok: boolean;
  detail: string;
}

export async function checkPdfHead(url: string): Promise<PdfCheck> {
  try {
    const res = await fetchWithRetry(url, { timeoutMs: 40_000, maxRetries: 2, headers: { Accept: 'application/pdf,*/*' } });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return { url, ok: false, detail: `HTTP ${res.status}` };
    }
    const reader = res.body.getReader();
    let got = new Uint8Array(0);
    while (got.length < 5) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const merged = new Uint8Array(got.length + value.length);
      merged.set(got);
      merged.set(value, got.length);
      got = merged;
    }
    await reader.cancel().catch(() => undefined);
    const head = new TextDecoder('latin1').decode(got.slice(0, 5));
    return head === '%PDF-' ? { url, ok: true, detail: 'ok' } : { url, ok: false, detail: `bad magic ${JSON.stringify(head)}` };
  } catch (err) {
    return { url, ok: false, detail: (err as Error).message.slice(0, 100) };
  }
}

export async function checkMany(urls: string[], concurrency = 3): Promise<PdfCheck[]> {
  return mapPool(urls, concurrency, (u) => checkPdfHead(u));
}

export async function checkImage(url: string): Promise<boolean> {
  try {
    const res = await fetchWithRetry(url, { method: 'HEAD', timeoutMs: 20_000, maxRetries: 1 });
    return res.ok && /^image\//i.test(res.headers.get('content-type') || '');
  } catch {
    return false;
  }
}
