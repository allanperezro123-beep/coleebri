/** OPDS (best effort): normal TLS only. On any failure the source is skipped and the reason reported. */
import { XMLParser } from 'fast-xml-parser';
import { appendJsonl, loadState, readJsonl, saveState } from './cache';
import { fetchWithRetry, TlsError } from './http';
import { emptyRec, normalizeDoi, normalizeIsbns, pickPdf, scieloIdFromUrl, scieloLanding, squash, stripTags, type Rec } from './model';

const START = 'https://opds.livros.scielo.org/opds/new';
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, trimValues: true });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'object' && v !== null ? String((v as Record<string, unknown>)['#text'] ?? '') : v == null ? '' : String(v));

interface Link {
  '@_rel'?: string;
  '@_href'?: string;
  '@_type'?: string;
}

function entryToRec(entry: Record<string, unknown>): Rec | null {
  const title = squash(text(entry.title));
  if (!title) return null;
  const links = arr(entry.link as Link | Link[]);
  const hrefs = links.map((l) => l['@_href']).filter(Boolean) as string[];
  const scieloId = hrefs.map(scieloIdFromUrl).find(Boolean) || scieloIdFromUrl(text(entry.id));
  const pdfLinks = links.filter((l) => /pdf/i.test(l['@_type'] || '') || /\.pdf($|\?)/i.test(l['@_href'] || '')).map((l) => l['@_href']);
  const epub = links.find((l) => /epub/i.test(l['@_type'] || '') || /\.epub($|\?)/i.test(l['@_href'] || ''))?.['@_href'];
  const pdf = pickPdf(pdfLinks, 'book');
  const authors = arr(entry.author as { name?: unknown } | Array<{ name?: unknown }>)
    .map((a) => squash(text(a.name)))
    .filter(Boolean);
  const identifiers = arr(entry.identifier as unknown).map(text);
  const doi = identifiers.map(normalizeDoi).find(Boolean);
  const issued = text(entry.issued || entry.date || entry.published);
  const year = Number(/\b(1[5-9]\d\d|20\d\d)\b/.exec(issued)?.[1]);
  return emptyRec({
    title,
    docType: 'book',
    scieloId,
    doi,
    isbns: normalizeIsbns(identifiers),
    authors,
    publisher: squash(text(entry.publisher)) || undefined,
    language: squash(text(entry.language)).toLowerCase().slice(0, 2),
    abstract: stripTags(text(entry.summary || entry.content)),
    year: Number.isFinite(year) ? year : null,
    pdfUrl: pdf.url,
    epubUrl: epub ? new URL(epub, START).toString() : undefined,
    scieloUrl: scieloId ? scieloLanding(scieloId) : doi ? `https://doi.org/${doi}` : undefined,
    origins: ['opds']
  });
}

export async function harvestOpds(max: number): Promise<{ records: Rec[]; skipped?: string }> {
  const name = 'opds';
  const state = loadState();
  const st = (state[name] ||= {});
  const have = new Map<string, Rec>();
  for (const r of readJsonl<Rec>(name)) have.set(r.scieloId || r.doi || r.title, r);
  if (st.done) return { records: [...have.values()].slice(0, max) };

  let next: string | null = st.cursor || START;
  let pages = 0;
  try {
    while (next && have.size < max && pages < 200) {
      const res = await fetchWithRetry(next, { timeoutMs: 30_000, maxRetries: 2, headers: { Accept: 'application/atom+xml, application/xml, text/xml' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = parser.parse(await res.text()) as { feed?: Record<string, unknown> };
      const feed = doc.feed;
      if (!feed) throw new Error('not an Atom/OPDS feed');
      const batch: Rec[] = [];
      for (const e of arr(feed.entry as Record<string, unknown> | Array<Record<string, unknown>>)) {
        const rec = entryToRec(e);
        if (!rec) continue;
        const key = rec.scieloId || rec.doi || rec.title;
        if (!have.has(key)) batch.push(rec);
        have.set(key, rec);
      }
      appendJsonl(name, batch);
      pages += 1;
      const nextHref = arr(feed.link as Link | Link[]).find((l) => l['@_rel'] === 'next')?.['@_href'];
      next = nextHref ? new URL(nextHref, next).toString() : null;
      st.cursor = next;
      if (!next) st.done = true;
      saveState({ ...loadState(), [name]: st });
      console.log(`[opds] page ${pages}: +${batch.length} (total ${have.size})`);
    }
  } catch (err) {
    const why = err instanceof TlsError ? `TLS certificate invalid/expired: ${err.message}` : (err as Error).message;
    return { records: [...have.values()].slice(0, max), skipped: `OPDS ${START} skipped: ${why}` };
  }
  return { records: [...have.values()].slice(0, max) };
}
