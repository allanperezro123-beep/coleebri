/** Minimal OAI-PMH client (ListRecords / Identify) on top of the polite fetchWithRetry layer. */
import { fetchWithRetry } from '../http';

export interface OaiPage {
  /** raw `<record>...</record>` strings, deleted records already removed */
  records: string[];
  token?: string;
  /** OAI error code (noRecordsMatch, badResumptionToken, ...), when the response carries one */
  error?: string;
  completeListSize?: number;
}

export async function oaiGet(base: string, params: Record<string, string>, opts: { timeoutMs?: number; maxRetries?: number } = {}): Promise<{ xml: string; status: number }> {
  const url = `${base}${base.includes('?') ? '&' : '?'}${new URLSearchParams(params).toString()}`;
  const res = await fetchWithRetry(url, { timeoutMs: opts.timeoutMs ?? 90_000, maxRetries: opts.maxRetries ?? 4, headers: { Accept: 'text/xml,application/xml;q=0.9,*/*;q=0.5' } });
  const xml = await res.text();
  return { xml, status: res.status };
}

export function parseListRecords(xml: string): OaiPage {
  const err = /<error\s+code="([^"]+)"/.exec(xml)?.[1];
  const tokenMatch = /<resumptionToken([^>]*)>([^<]*)<\/resumptionToken>/.exec(xml);
  const size = Number(/completeListSize="(\d+)"/.exec(tokenMatch?.[1] ?? '')?.[1]);
  const records: string[] = [];
  const re = /<record>([\s\S]*?)<\/record>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (/<header[^>]*status="deleted"/.test(m[1])) continue;
    records.push(m[1]);
  }
  return { records, token: tokenMatch?.[2]?.trim() || undefined, error: err, completeListSize: Number.isFinite(size) ? size : undefined };
}

export async function identify(base: string): Promise<{ ok: boolean; name?: string; detail: string }> {
  try {
    const { xml, status } = await oaiGet(base, { verb: 'Identify' }, { timeoutMs: 25_000, maxRetries: 1 });
    const name = /<repositoryName>([^<]*)<\/repositoryName>/.exec(xml)?.[1];
    if (name) return { ok: true, name, detail: `HTTP ${status}` };
    const challenge = /Just a moment|Making sure you.?re not a bot|cf-chl|challenge-platform|anubis/i.test(xml);
    return { ok: false, detail: challenge ? `HTTP ${status}: anti-bot challenge page (not bypassed)` : `HTTP ${status}: not an OAI-PMH response` };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    return { ok: false, detail: `${e.cause?.code || e.name}: ${e.message}`.slice(0, 140) };
  }
}
