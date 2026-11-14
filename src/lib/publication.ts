import type {
  DocumentType,
  LanguageCode,
  OecdAreaDefinition,
  OecdAreaId,
  Publication,
  Shelf,
  ShelfItem
} from '../types/publication';
import { OECD_AREA_MAP, inferCountry } from './taxonomy';
import { safeExternalUrl, safeHexColor } from './safeUrl';

export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  es: 'Español',
  pt: 'Portugués',
  en: 'Inglés',
  other: 'Otro idioma'
};

export const DOCTYPE_LABELS: Record<DocumentType, string> = {
  book: 'Libro',
  chapter: 'Capítulo',
  article: 'Artículo'
};

const LANGUAGES = new Set<string>(['es', 'pt', 'en', 'other']);
const DOC_TYPES = new Set<string>(['book', 'chapter', 'article']);
const SOURCES = new Set<string>(['oai-pmh', 'opds', 'openalex', 'hybrid']);
const FALLBACK_AREA: OecdAreaId = 'social-sciences';

/** Never throws: an unknown / missing area falls back to social sciences (B12). */
export function getArea(id: unknown): OecdAreaDefinition {
  return (typeof id === 'string' && OECD_AREA_MAP[id as OecdAreaId]) || OECD_AREA_MAP[FALLBACK_AREA];
}

/** CSS variable that holds the contrast-safe TEXT colour of an area (light + dark). */
export function areaTextColor(id: unknown): string {
  return 'var(--area-' + getArea(id).id + '-text)';
}

/** CSS variable of the area's graphic colour (bars, dots). */
export function areaFillColor(id: unknown): string {
  return 'var(--area-' + getArea(id).id + ')';
}

/** `lang` attribute for content that may not be in the UI language. */
export function langAttr(pub: Pick<Publication, 'language'>): string | undefined {
  return pub.language === 'pt' || pub.language === 'en' ? pub.language : undefined;
}

export function formatAuthors(pub: Publication, max = 3): string {
  if (pub.authors.length === 0) return pub.publisher;
  return pub.authors.slice(0, max).join('; ') + (pub.authors.length > max ? ' et al.' : '');
}

function str(value: unknown, max = 5000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function strList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = str(v, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Turns anything that came from the API, the bundled seed or localStorage into a safe
 * Publication, or null when it is unusable. Unknown enums are coerced, URLs are validated, the
 * country is re-inferred (with ISBN). The same function runs for seed and live items (B14).
 */
export function normalizePublication(raw: unknown): Publication | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 200);
  const title = str(r.title, 600);
  if (!id || !title) return null;

  const area = getArea(r.oecdArea);
  const language = LANGUAGES.has(r.language as string) ? (r.language as LanguageCode) : 'other';
  const docType = DOC_TYPES.has(r.docType as string) ? (r.docType as DocumentType) : 'book';
  const year =
    typeof r.year === 'number' && Number.isFinite(r.year) && r.year >= 1000 && r.year <= 2200
      ? Math.trunc(r.year)
      : null;

  const publisher = str(r.publisher, 240) || 'SciELO';
  const collectionCode = str(r.collectionCode, 60) || 'books';
  const collection = str(r.collection, 160) || 'SciELO Books';
  const scieloUrl = safeExternalUrl(r.scieloUrl) ?? '';
  const pdfUrl = safeExternalUrl(r.pdfUrl);
  const isbn = str(r.isbn, 60) || undefined;

  const pub: Publication = {
    id,
    title,
    authors: strList(r.authors, 60, 160),
    publisher,
    collection,
    collectionCode,
    year,
    language,
    docType,
    oecdArea: area.id,
    oecdAreaLabel: area.label,
    abstract: str(r.abstract, 6000),
    keywords: strList(r.keywords, 24, 80),
    scieloUrl,
    sourceOrigin: SOURCES.has(r.sourceOrigin as string)
      ? (r.sourceOrigin as Publication['sourceOrigin'])
      : 'openalex'
  };

  const subtitle = str(r.subtitle, 400);
  if (subtitle) pub.subtitle = subtitle;
  const oaiIdentifier = str(r.oaiIdentifier, 300);
  if (oaiIdentifier) pub.oaiIdentifier = oaiIdentifier;
  const subarea = str(r.oecdSubarea, 160);
  if (subarea) pub.oecdSubarea = subarea;
  const doi = str(r.doi, 240);
  if (doi) pub.doi = doi;
  if (isbn) pub.isbn = isbn;
  if (pdfUrl) pub.pdfUrl = pdfUrl;
  const epubUrl = safeExternalUrl(r.epubUrl);
  if (epubUrl) pub.epubUrl = epubUrl;
  const coverUrl = safeExternalUrl(r.coverUrl);
  if (coverUrl) pub.coverUrl = coverUrl;
  if (typeof r.pageCount === 'number' && r.pageCount > 0) pub.pageCount = Math.trunc(r.pageCount);
  if (typeof r.citedByCount === 'number' && r.citedByCount >= 0) pub.citedByCount = Math.trunc(r.citedByCount);

  pub.country = inferCountry({
    country: str(r.country, 80) || undefined,
    collectionCode,
    collection,
    scieloUrl,
    pdfUrl,
    publisher,
    isbn
  });
  return pub;
}

export function normalizePublications(raw: unknown): Publication[] {
  if (!Array.isArray(raw)) return [];
  const out: Publication[] = [];
  for (const entry of raw) {
    const pub = normalizePublication(entry);
    if (pub) out.push(pub);
  }
  return out;
}

const SHELF_ID = /^[A-Za-z0-9:._-]{1,120}$/;

/** Accepts ISO strings and SQLite `YYYY-MM-DD HH:MM:SS` (UTC) timestamps. */
export function timestamp(value: string): number {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  return Date.parse(normalized);
}

function isoOrNow(value: unknown): string {
  return typeof value === 'string' && value && !Number.isNaN(timestamp(value)) ? value : new Date().toISOString();
}

export function normalizeShelf(raw: unknown): Shelf | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 120);
  const name = str(r.name, 80);
  if (!id || !SHELF_ID.test(id) || !name) return null;
  const description = str(r.description, 240);
  return {
    id,
    name,
    description: description || undefined,
    accent: safeHexColor(r.accent),
    createdAt: isoOrNow(r.createdAt),
    updatedAt: isoOrNow(r.updatedAt)
  };
}

export function normalizeShelfItem(raw: unknown): ShelfItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const shelfId = str(r.shelfId, 120);
  const publication = normalizePublication(r.publication);
  if (!shelfId || !SHELF_ID.test(shelfId) || !publication) return null;
  const page =
    typeof r.readingPage === 'number' && Number.isFinite(r.readingPage)
      ? Math.max(1, Math.trunc(r.readingPage))
      : 1;
  return {
    id: shelfId + '::' + publication.id,
    shelfId,
    publicationId: publication.id,
    publication,
    note: str(r.note, 4000),
    readingPage: page,
    addedAt: isoOrNow(r.addedAt),
    updatedAt: isoOrNow(r.updatedAt)
  };
}

export function normalizeShelves(raw: unknown): Shelf[] {
  if (!Array.isArray(raw)) return [];
  const out: Shelf[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const shelf = normalizeShelf(entry);
    if (shelf && !seen.has(shelf.id)) {
      seen.add(shelf.id);
      out.push(shelf);
    }
  }
  return out;
}

export function normalizeShelfItems(raw: unknown): ShelfItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ShelfItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = normalizeShelfItem(entry);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}
