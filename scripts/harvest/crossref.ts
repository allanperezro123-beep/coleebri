/** Crossref: monographs under DOI prefix 10.7476 (cursor loop, 1000 rows/page, resumable). */
import { appendJsonl, loadState, readJsonl, saveState } from './cache';
import { fetchWithRetry } from './http';
import {
  emptyRec,
  normalizeDoi,
  normalizeIsbns,
  pickPdf,
  scieloIdFromUrl,
  scieloLanding,
  squash,
  stripTags,
  type Rec
} from './model';

const SELECT = 'DOI,title,subtitle,author,editor,publisher,ISBN,type,issued,link,resource,abstract,subject,URL';

interface CrPerson {
  given?: string;
  family?: string;
  name?: string;
}

interface CrItem {
  DOI: string;
  title?: string[];
  subtitle?: string[];
  author?: CrPerson[];
  editor?: CrPerson[];
  publisher?: string;
  ISBN?: string[];
  issued?: { 'date-parts'?: number[][] };
  link?: Array<{ URL?: string }>;
  resource?: { primary?: { URL?: string } };
  abstract?: string;
  subject?: string[];
}

export const crossrefStats = { pdfIdMismatch: 0 };

function person(p: CrPerson): string {
  if (p.name) return squash(p.name);
  return squash([p.family, p.given].filter(Boolean).join(', '));
}

export function normalizeItem(it: CrItem): Rec | null {
  const title = squash(it.title?.[0] || '');
  const doi = normalizeDoi(it.DOI);
  if (!title || !doi) return null;
  const resourceId = scieloIdFromUrl(it.resource?.primary?.URL);
  const links = (it.link || []).map((l) => l.URL).filter(Boolean) as string[];
  // Crossref sometimes points `link` at ANOTHER book's static.scielo.org PDF: only trust it when ids agree.
  const trusted = links.filter((l) => {
    const lid = scieloIdFromUrl(l);
    if (!resourceId || !lid) return true;
    if (lid === resourceId) return true;
    crossrefStats.pdfIdMismatch += 1;
    return false;
  });
  const scieloId = resourceId || trusted.map(scieloIdFromUrl).find(Boolean);
  const pdf = pickPdf(trusted, 'book');
  const people = (it.author?.length ? it.author : it.editor) || [];
  const year = it.issued?.['date-parts']?.[0]?.[0];
  const rec = emptyRec({
    title,
    subtitle: squash(it.subtitle?.[0] || '') || undefined,
    docType: 'book',
    doi,
    scieloId,
    isbns: normalizeIsbns(it.ISBN || []),
    publisher: squash(it.publisher || '') || undefined,
    authors: people.map(person).filter(Boolean),
    year: typeof year === 'number' ? year : null,
    abstract: it.abstract ? stripTags(it.abstract) : '',
    keywords: (it.subject || []).map((s) => squash(s)).filter(Boolean).slice(0, 12),
    scieloUrl: scieloId ? scieloLanding(scieloId) : `https://doi.org/${doi}`,
    pdfUrl: pdf.url,
    origins: ['crossref']
  });
  if (pdf.chapterOnly && !pdf.url) (rec as Rec & { chapterOnlyPdf?: string }).chapterOnlyPdf = pdf.chapterOnly;
  return rec;
}

export interface CrossrefResult {
  records: Rec[];
  note?: string;
  pages: number;
}

async function loopType(type: string, max: number): Promise<{ recs: Rec[]; pages: number; note?: string }> {
  const name = `crossref-${type}`;
  const state = loadState();
  const st = (state[name] ||= {});
  const byDoi = new Map<string, Rec>();
  for (const r of readJsonl<Rec>(name)) if (r.doi) byDoi.set(r.doi, r);
  let pages = 0;
  let note: string | undefined;
  if (st.done || byDoi.size >= max) return { recs: [...byDoi.values()].slice(0, max), pages };

  let cursor = st.cursor ?? '*';
  while (cursor && byDoi.size < max) {
    const rows = 1000;
    const url =
      `https://api.crossref.org/prefixes/10.7476/works?filter=type:${type}&rows=${rows}` +
      `&cursor=${encodeURIComponent(cursor)}&select=${SELECT}`;
    let res: Response;
    try {
      res = await fetchWithRetry(url, { timeoutMs: 90_000 });
    } catch (err) {
      note = `Crossref ${type}: ${(err as Error).message}`;
      break;
    }
    if (!res.ok) {
      note = `Crossref ${type}: HTTP ${res.status}`;
      break;
    }
    const json = (await res.json()) as { message?: { items?: CrItem[]; 'next-cursor'?: string } };
    const items = json.message?.items || [];
    const batch: Rec[] = [];
    for (const it of items) {
      const rec = normalizeItem(it);
      if (!rec?.doi) continue;
      if (!byDoi.has(rec.doi)) batch.push(rec);
      byDoi.set(rec.doi, rec);
    }
    appendJsonl(name, batch);
    pages += 1;
    cursor = items.length ? json.message?.['next-cursor'] || '' : '';
    st.cursor = cursor || null;
    st.count = byDoi.size;
    if (!cursor) st.done = true;
    saveState({ ...loadState(), [name]: st });
    console.log(`[crossref:${type}] page ${pages}: +${batch.length} (total ${byDoi.size})`);
    if (st.done) break;
  }
  return { recs: [...byDoi.values()].slice(0, max), pages, note };
}

export async function harvestCrossref(max: number): Promise<CrossrefResult> {
  const out: Rec[] = [];
  let pages = 0;
  const notes: string[] = [];
  for (const type of ['monograph', 'edited-book']) {
    const r = await loopType(type, Math.max(0, max - out.length));
    out.push(...r.recs);
    pages += r.pages;
    if (r.note) notes.push(r.note);
  }
  return { records: out, pages, note: notes.join('; ') || undefined };
}
