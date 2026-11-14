import { OECD_AREA_MAP, inferCountry } from '../src/lib/taxonomy';
import type { DocumentType, LanguageCode, OecdAreaId, Publication } from '../src/types/publication';
import { json, safeUrlString } from './security';

export interface Env {
  DB?: D1Database;
  ASSETS?: Fetcher;
  /** Secret (>= 24 chars) required for catalog writes and harvesting. `wrangler pages secret put ADMIN_TOKEN` */
  ADMIN_TOKEN?: string;
  /** Optional contact e-mail for the OpenAlex/Crossref polite pool. Never hardcoded in source. */
  CONTACT_EMAIL?: string;
}

export interface PublicationRow {
  id: string;
  oai_identifier: string | null;
  title: string;
  subtitle: string | null;
  authors_json: string;
  publisher: string;
  country?: string | null;
  collection: string;
  collection_code: string;
  publication_year: number | null;
  publication_date: string | null;
  language: string;
  doc_type: string;
  oecd_area: string;
  oecd_area_label: string;
  oecd_subarea: string | null;
  abstract: string | null;
  keywords_json: string;
  doi: string | null;
  isbn: string | null;
  scielo_url: string;
  pdf_url: string | null;
  epub_url: string | null;
  cover_url: string | null;
  page_count: number | null;
  cited_by_count: number;
  source_origin: string;
  raw_set_spec: string | null;
}

export function rowToPublication(row: PublicationRow): Publication {
  let authors: string[] = [];
  let keywords: string[] = [];
  try {
    authors = JSON.parse(row.authors_json || '[]');
  } catch {
    authors = [];
  }
  try {
    keywords = JSON.parse(row.keywords_json || '[]');
  } catch {
    keywords = [];
  }

  if (!Array.isArray(authors)) authors = [];
  if (!Array.isArray(keywords)) keywords = [];
  authors = authors.filter((a): a is string => typeof a === 'string');
  const oecdArea = normalizeOecdArea(row.oecd_area);

  return {
    id: row.id,
    oaiIdentifier: row.oai_identifier ?? undefined,
    title: row.title,
    subtitle: row.subtitle ?? undefined,
    authors,
    publisher: row.publisher,
    country: inferCountry({
      country: row.country,
      collectionCode: row.collection_code,
      collection: row.collection,
      scieloUrl: row.scielo_url,
      pdfUrl: row.pdf_url,
      publisher: row.publisher
    }),
    collection: row.collection,
    collectionCode: row.collection_code,
    year: row.publication_year,
    publicationDate: row.publication_date ?? undefined,
    language: normalizeLanguageCode(row.language),
    docType: normalizeDocType(row.doc_type),
    oecdArea: oecdArea,
    oecdAreaLabel: row.oecd_area_label || OECD_AREA_MAP[oecdArea].label,
    oecdSubarea: row.oecd_subarea ?? undefined,
    abstract: row.abstract || '',
    keywords: keywords.filter((k): k is string => typeof k === 'string'),
    doi: row.doi ?? undefined,
    isbn: row.isbn ?? undefined,
    // Defence in depth: only trusted https URLs ever leave the API (no javascript:/data: links).
    scieloUrl: safeUrlString(row.scielo_url) ?? (row.doi ? `https://doi.org/${encodeURIComponent(row.doi).replace(/%2F/gi, '/')}` : 'https://books.scielo.org/'),
    pdfUrl: safeUrlString(row.pdf_url),
    epubUrl: safeUrlString(row.epub_url),
    coverUrl: safeUrlString(row.cover_url),
    pageCount: row.page_count ?? undefined,
    citedByCount: row.cited_by_count ?? 0,
    sourceOrigin: (['oai-pmh', 'opds', 'openalex'].includes(row.source_origin)
      ? row.source_origin
      : 'oai-pmh') as Publication['sourceOrigin'],
    rawSetSpec: row.raw_set_spec ?? undefined
  };
}

const LANGUAGE_CODES = new Set<LanguageCode>(['es', 'pt', 'en', 'other']);
const DOC_TYPES = new Set<DocumentType>(['book', 'chapter', 'article']);

export function normalizeLanguageCode(value: unknown): LanguageCode {
  return LANGUAGE_CODES.has(value as LanguageCode) ? (value as LanguageCode) : 'other';
}

export function normalizeDocType(value: unknown): DocumentType {
  return DOC_TYPES.has(value as DocumentType) ? (value as DocumentType) : 'book';
}

export function normalizeOecdArea(value: unknown): OecdAreaId {
  return typeof value === 'string' && value in OECD_AREA_MAP ? (value as OecdAreaId) : 'social-sciences';
}

/** Kept for backwards compatibility: same-origin JSON response without wildcard CORS. */
export function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return json(data, status, extraHeaders);
}
