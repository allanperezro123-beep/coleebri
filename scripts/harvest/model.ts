/** Internal harvest record + pure helpers (ISBN, DOI, SciELO ids, full-text rules). */
import { safeHttpUrl } from '../../functions/security';

export type DocType = 'book' | 'chapter' | 'article';

export interface Rec {
  /** SciELO Books id (books.scielo.org/id/<id>) */
  scieloId?: string;
  openalexId?: string;
  doi?: string;
  /** ISBN-13s, print first */
  isbns: string[];
  title: string;
  subtitle?: string;
  authors: string[];
  publisher?: string;
  year?: number | null;
  publicationDate?: string;
  /** raw ISO-ish code from the source ('pt', 'es', 'en', 'fr', ...) or '' when unknown */
  language: string;
  docType: DocType;
  abstract: string;
  keywords: string[];
  pdfUrl?: string;
  epubUrl?: string;
  coverUrl?: string;
  scieloUrl?: string;
  pageCount?: number;
  cited: number;
  fieldName?: string;
  domainId?: string;
  collection?: string;
  collectionCode?: string;
  /** Ids of articles etc. that have no SciELO book id */
  externalId?: string;
  /** extra sources: journal / series title (country hint) and OAI set or ranking tag */
  journal?: string;
  setSpec?: string;
  origins: string[];
}

export function emptyRec(partial: Partial<Rec> & { title: string; docType: DocType }): Rec {
  return { isbns: [], authors: [], language: '', abstract: '', keywords: [], cited: 0, origins: [], ...partial };
}

/* ---------------------------------- text ---------------------------------- */

/** Collapses all whitespace (incl. newlines) so every SQL statement stays on one line. */
export function squash(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function stripTags(input: string): string {
  return squash(decodeEntities(input.replace(/<[^>]*>/g, ' ')));
}

/* ---------------------------------- ISBN ---------------------------------- */

export function isbn10to13(digits10: string): string | null {
  if (!/^\d{9}[\dXx]$/.test(digits10)) return null;
  const core = `978${digits10.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  return `${core}${(10 - (sum % 10)) % 10}`;
}

/** Returns a normalized ISBN-13 (digits only) or null. ISBN-10s are converted. */
export function normalizeIsbn(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/[^0-9Xx]/g, '');
  if (digits.length === 13 && /^97[89]\d{10}$/.test(digits)) return digits;
  if (digits.length === 10) return isbn10to13(digits);
  return null;
}

export function normalizeIsbns(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    // a field may contain several ISBNs separated by ; , or spaces
    for (const part of String(v ?? '').split(/[;,]|\s{2,}/)) {
      const n = normalizeIsbn(part);
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/* ----------------------------------- DOI ---------------------------------- */

export function normalizeDoi(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const doi = raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .trim()
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined;
}

/* -------------------------------- SciELO ids ------------------------------- */

const SCIELO_BOOK_ID = /(?:books|static)\.scielo\.org\/(?:id|scielobooks)\/([a-z0-9]{2,12})(?=[/?#]|$)/i;

export function scieloIdFromUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  return SCIELO_BOOK_ID.exec(url)?.[1]?.toLowerCase();
}

export function scieloLanding(id: string): string {
  return `https://books.scielo.org/id/${id}`;
}

export function scieloCover(id: string): string {
  return `https://books.scielo.org/id/${id}/cover/cover_thumbnail.jpeg`;
}

/* ------------------------------- full-text rules --------------------------- */

/**
 * Real full text = direct PDF on an allowlisted host whose path ends in .pdf, or a SciELO
 * `?format=pdf` / `/pdf/` URL. Returns the sanitized (https) URL or undefined.
 */
export function fullTextPdf(url: unknown): string | undefined {
  const parsed = safeHttpUrl(url);
  if (!parsed) return undefined;
  const p = parsed.pathname.toLowerCase();
  const isScielo = /(^|\.)scielo\./i.test(parsed.hostname);
  const ok = p.endsWith('.pdf') || (isScielo && (parsed.searchParams.get('format')?.toLowerCase() === 'pdf' || /\/pdf\//.test(p)));
  return ok ? parsed.toString() : undefined;
}

/** `/id/<id>/pdf/<name>-07.pdf` style chapter PDFs of a SciELO book. */
export function isChapterPdf(url: string): boolean {
  return /-\d{2}\.pdf$/i.test(url.split(/[?#]/)[0]);
}

/** Picks the best PDF among candidates: allowlisted, full-text; for books prefer full-book over chapter PDFs. */
export function pickPdf(candidates: Array<string | undefined | null>, docType: DocType): { url?: string; chapterOnly?: string } {
  const valid = candidates.map((c) => fullTextPdf(c)).filter((c): c is string => Boolean(c));
  if (docType !== 'book') return { url: valid[0] };
  const whole = valid.find((c) => !isChapterPdf(c));
  const chapterOnly = valid.find((c) => isChapterPdf(c));
  return { url: whole, chapterOnly };
}

export function normTitle(t: string): string {
  return t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Dedupe keys in priority order. */
export function keysOf(r: Rec): string[] {
  const keys: string[] = [];
  if (r.scieloId && r.docType === 'book') keys.push(`sb:${r.scieloId}`);
  if (r.doi) keys.push(`doi:${r.doi}`);
  if (r.docType === 'book') for (const i of r.isbns) keys.push(`isbn:${i}`);
  if (r.openalexId) keys.push(`oa:${r.openalexId}`);
  if (r.externalId) keys.push(`ext:${r.externalId}`);
  const nt = normTitle(r.title);
  if (nt.length >= 6) keys.push(`ty:${r.docType}|${nt}|${r.year ?? ''}`);
  return keys;
}

export function languageCode(raw: string): 'es' | 'pt' | 'en' | 'other' {
  const l = raw.toLowerCase().slice(0, 2);
  return l === 'es' || l === 'pt' || l === 'en' ? l : 'other';
}
