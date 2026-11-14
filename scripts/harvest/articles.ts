/** OPTIONAL (--with-articles): capped OAI-PMH pass over regional SciELO journal-article endpoints. */
import { XMLParser } from 'fast-xml-parser';
import { appendJsonl, loadState, readJsonl, saveState } from './cache';
import { fetchWithRetry, TlsError } from './http';
import { emptyRec, normalizeDoi, squash, stripTags, type Rec } from './model';

const ENDPOINTS: Array<{ code: string; label: string; url: string }> = [
  { code: 'mx', label: 'SciELO México', url: 'https://www.scielo.org.mx/oai/scielo-oai.php' },
  { code: 'pe', label: 'SciELO Perú', url: 'https://www.scielo.org.pe/oai/scielo-oai.php' }
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, trimValues: true });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : typeof v === 'object' && v !== null ? String((v as Record<string, unknown>)['#text'] ?? '') : '');

function toRec(code: string, label: string, header: Record<string, unknown>, dc: Record<string, unknown>): Rec | null {
  const title = squash(arr(dc.title as unknown).map(text)[0] || '');
  const oai = text(header.identifier);
  if (!title || !oai) return null;
  const idents = arr(dc.identifier as unknown).map(text);
  const url = idents.find((i) => /^https?:\/\//i.test(i));
  const doi = idents.map(normalizeDoi).find(Boolean);
  const date = text(arr(dc.date as unknown)[0]);
  const year = Number(/\b(1[5-9]\d\d|20\d\d)\b/.exec(date)?.[1]);
  return emptyRec({
    title,
    docType: 'article',
    externalId: oai,
    doi,
    authors: arr(dc.creator as unknown).map((a) => squash(text(a))).filter(Boolean),
    publisher: squash(arr(dc.publisher as unknown).map(text)[0] || '') || undefined,
    language: squash(arr(dc.language as unknown).map(text)[0] || '').toLowerCase().slice(0, 2),
    abstract: stripTags(arr(dc.description as unknown).map(text)[0] || ''),
    keywords: arr(dc.subject as unknown).map((s) => squash(text(s))).filter(Boolean).slice(0, 12),
    year: Number.isFinite(year) ? year : null,
    publicationDate: /^\d{4}(-\d{2}-\d{2})?$/.test(date) ? date : undefined,
    scieloUrl: url,
    collection: label,
    collectionCode: `scielo-${code}`,
    origins: ['oai-articles']
  });
}

export async function harvestArticles(cap: number): Promise<{ records: Rec[]; skipped: string[] }> {
  const records: Rec[] = [];
  const skipped: string[] = [];
  for (const ep of ENDPOINTS) {
    const name = `articles-${ep.code}`;
    const have = readJsonl<Rec>(name);
    records.push(...have);
    const state = loadState();
    const st = (state[name] ||= {});
    if (st.done || records.length >= cap) continue;
    let token: string | null = st.cursor || null;
    try {
      while (records.length < cap) {
        const url: string = token
          ? `${ep.url}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`
          : `${ep.url}?verb=ListRecords&metadataPrefix=oai_dc`;
        const res = await fetchWithRetry(url, { timeoutMs: 40_000, maxRetries: 2 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = parser.parse(await res.text()) as { 'OAI-PMH'?: { ListRecords?: Record<string, unknown>; error?: unknown } };
        const list = doc['OAI-PMH']?.ListRecords;
        if (!list) throw new Error(`no ListRecords (${text(doc['OAI-PMH']?.error) || 'unknown'})`);
        const batch: Rec[] = [];
        for (const item of arr(list.record as Record<string, unknown> | Array<Record<string, unknown>>)) {
          const header = (item.header || {}) as Record<string, unknown>;
          const dc = ((item.metadata as Record<string, unknown> | undefined)?.dc || {}) as Record<string, unknown>;
          const rec = toRec(ep.code, ep.label, header, dc);
          if (rec && records.length + batch.length < cap) batch.push(rec);
        }
        appendJsonl(name, batch);
        records.push(...batch);
        token = text(list.resumptionToken) || null;
        st.cursor = token;
        if (!token) st.done = true;
        saveState({ ...loadState(), [name]: st });
        console.log(`[articles:${ep.code}] +${batch.length} (total ${records.length})`);
        if (!token) break;
      }
    } catch (err) {
      skipped.push(`${ep.url}: ${err instanceof TlsError ? 'TLS ' : ''}${(err as Error).message}`);
    }
  }
  return { records: records.slice(0, cap), skipped };
}
