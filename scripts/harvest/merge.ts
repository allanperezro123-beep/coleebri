/**
 * De-duplication + "richest value per field" merge.
 * Key priority: SciELO book id → lowercase DOI → ISBN-13 → normalized title+year (conflict-guarded).
 */
import { isChapterPdf, keysOf, type Rec } from './model';

type WithChapterPdf = Rec & { chapterOnlyPdf?: string };

const GENERIC_PUBLISHER = /^(scielo|scielo books|scielo network|red scielo|editora scielo)$/i;
const LANG_RANK: Record<string, number> = { landing: 3, openalex: 2, opds: 2, crossref: 1 };

function langRank(r: Rec): number {
  return Math.max(0, ...r.origins.map((o) => LANG_RANK[o] ?? 1));
}

export function mergeInto(base: Rec, other: Rec): Rec {
  const out: WithChapterPdf = { ...base };
  const o = other as WithChapterPdf;
  const longer = (a?: string, b?: string) => ((b || '').length > (a || '').length ? b : a);

  out.title = longer(base.title, other.title) || base.title;
  out.subtitle = longer(base.subtitle, other.subtitle);
  out.abstract = longer(base.abstract, other.abstract) || '';
  out.authors = other.authors.length > base.authors.length ? other.authors : base.authors;
  out.keywords = [...new Set([...base.keywords, ...other.keywords])].slice(0, 15);
  out.isbns = [...new Set([...base.isbns, ...other.isbns])];
  out.doi = base.doi || other.doi;
  out.scieloId = base.scieloId || other.scieloId;
  out.openalexId = base.openalexId || other.openalexId;
  out.externalId = base.externalId || other.externalId;
  out.year = base.year ?? other.year ?? null;
  out.publicationDate = base.publicationDate || other.publicationDate;
  out.cited = Math.max(base.cited, other.cited);
  out.pageCount = base.pageCount || other.pageCount;
  out.fieldName = base.fieldName || other.fieldName;
  out.domainId = base.domainId || other.domainId;
  out.coverUrl = base.coverUrl || other.coverUrl;
  out.epubUrl = base.epubUrl || other.epubUrl;
  out.collection = base.collection || other.collection;
  out.collectionCode = base.collectionCode || other.collectionCode;
  out.scieloUrl = base.scieloUrl && !/doi\.org/.test(base.scieloUrl) ? base.scieloUrl : other.scieloUrl || base.scieloUrl;

  const pubGeneric = (p?: string) => !p || GENERIC_PUBLISHER.test(p);
  out.publisher = pubGeneric(base.publisher) && !pubGeneric(other.publisher) ? other.publisher : base.publisher || other.publisher;

  // language: prefer the most authoritative non-empty source
  if (!base.language) out.language = other.language;
  else if (other.language && langRank(other) > langRank(base)) out.language = other.language;

  // pdf: any non-empty; for books prefer the full-book PDF over a chapter PDF
  const pdfs = [base.pdfUrl, other.pdfUrl].filter(Boolean) as string[];
  out.pdfUrl = pdfs.find((p) => !isChapterPdf(p)) ?? pdfs[0];
  out.chapterOnlyPdf = base.chapterOnlyPdf || o.chapterOnlyPdf;
  out.origins = [...new Set([...base.origins, ...other.origins])];
  return out;
}

function conflicts(a: Rec, b: Rec, key: string): boolean {
  if (a.docType !== b.docType) return true;
  if (a.scieloId && b.scieloId && a.scieloId !== b.scieloId) return true;
  // weak key (title+year): different DOIs / different ISBNs mean different works
  if (key.startsWith('ty:')) {
    if (a.doi && b.doi && a.doi !== b.doi) return true;
    if (a.isbns.length && b.isbns.length && !a.isbns.some((i) => b.isbns.includes(i))) return true;
  }
  return false;
}

export interface DedupeResult {
  records: Rec[];
  merges: number;
  mergesByKey: Record<string, number>;
}

export function dedupe(input: Rec[]): DedupeResult {
  const groups: Rec[] = [];
  const index = new Map<string, number>();
  let merges = 0;
  const mergesByKey: Record<string, number> = {};

  for (const rec of input) {
    let target = -1;
    let via = '';
    for (const k of keysOf(rec)) {
      const idx = index.get(k);
      if (idx === undefined) continue;
      if (conflicts(groups[idx], rec, k)) continue;
      target = idx;
      via = k.split(':')[0];
      break;
    }
    if (target === -1) {
      groups.push(rec);
      target = groups.length - 1;
    } else {
      groups[target] = mergeInto(groups[target], rec);
      merges += 1;
      mergesByKey[via] = (mergesByKey[via] || 0) + 1;
    }
    for (const k of keysOf(groups[target])) if (!index.has(k)) index.set(k, target);
  }
  return { records: groups, merges, mergesByKey };
}
