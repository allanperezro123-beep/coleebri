import { normalizeDocType, normalizeLanguageCode, normalizeOecdArea } from './types';
import { OECD_AREA_MAP, inferCountry } from '../src/lib/taxonomy';
import type { Publication } from '../src/types/publication';
import { buildSearchText, cleanText, safeUrlString } from './security';

/** Normalizes an untrusted publication into a safe DB row (bounded text, allowlisted URLs/enums). */
export function sanitizePublication(p: Partial<Publication>): Publication | null {
  const id = cleanText(p.id, 120);
  const title = cleanText(p.title, 500);
  const scieloUrl = safeUrlString(p.scieloUrl);
  if (!id || !/^[A-Za-z0-9:._-]+$/.test(id) || !title || !scieloUrl) return null;
  const oecdArea = normalizeOecdArea(p.oecdArea);
  const year = typeof p.year === 'number' && p.year >= 1500 && p.year <= 2100 ? Math.trunc(p.year) : null;
  const authors = Array.isArray(p.authors) ? p.authors.map((a) => cleanText(a, 160)).filter(Boolean).slice(0, 25) : [];
  const keywords = Array.isArray(p.keywords) ? p.keywords.map((k) => cleanText(k, 80)).filter(Boolean).slice(0, 15) : [];
  const publisher = cleanText(p.publisher, 200) || 'SciELO';
  const collection = cleanText(p.collection, 120) || 'SciELO Books';
  const collectionCode = cleanText(p.collectionCode, 40).replace(/[^a-z0-9-]/gi, '') || 'books';
  const pdfUrl = safeUrlString(p.pdfUrl);
  return {
    id,
    oaiIdentifier: cleanText(p.oaiIdentifier, 200) || id,
    title,
    subtitle: cleanText(p.subtitle, 300) || undefined,
    authors,
    publisher,
    country: inferCountry({
      country: cleanText(p.country, 60) || undefined,
      collectionCode,
      collection,
      scieloUrl,
      pdfUrl,
      publisher,
      isbn: cleanText(p.isbn, 40) || undefined
    }),
    collection,
    collectionCode,
    year,
    publicationDate: cleanText(p.publicationDate, 32) || undefined,
    language: normalizeLanguageCode(p.language),
    docType: normalizeDocType(p.docType),
    oecdArea,
    oecdAreaLabel: OECD_AREA_MAP[oecdArea].label,
    oecdSubarea: cleanText(p.oecdSubarea, 120) || undefined,
    abstract: cleanText(p.abstract, 8000),
    keywords,
    doi: cleanText(p.doi, 200).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') || undefined,
    isbn: cleanText(p.isbn, 40) || undefined,
    scieloUrl,
    pdfUrl,
    epubUrl: safeUrlString(p.epubUrl),
    coverUrl: safeUrlString(p.coverUrl),
    pageCount: typeof p.pageCount === 'number' && p.pageCount > 0 && p.pageCount < 20000 ? Math.trunc(p.pageCount) : undefined,
    citedByCount: typeof p.citedByCount === 'number' && p.citedByCount >= 0 ? Math.min(1e7, Math.trunc(p.citedByCount)) : 0,
    sourceOrigin: p.sourceOrigin === 'opds' || p.sourceOrigin === 'oai-pmh' ? p.sourceOrigin : 'openalex',
    rawSetSpec: cleanText(p.rawSetSpec, 200) || undefined
  };
}

export const UPSERT_PUBLICATION_SQL = `
  INSERT INTO publications (
    id, oai_identifier, title, subtitle, authors_json, publisher, country,
    collection, collection_code, publication_year, publication_date,
    language, doc_type, oecd_area, oecd_area_label, oecd_subarea,
    abstract, keywords_json, doi, isbn, scielo_url, pdf_url,
    epub_url, cover_url, page_count, cited_by_count, source_origin, raw_set_spec, search_text, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    authors_json = CASE WHEN excluded.authors_json != '[]' THEN excluded.authors_json ELSE publications.authors_json END,
    country = CASE WHEN publications.country = 'Internacional' THEN excluded.country ELSE publications.country END,
    abstract = CASE WHEN length(excluded.abstract) > length(COALESCE(publications.abstract, '')) THEN excluded.abstract ELSE publications.abstract END,
    pdf_url = COALESCE(excluded.pdf_url, publications.pdf_url),
    epub_url = COALESCE(excluded.epub_url, publications.epub_url),
    cover_url = COALESCE(excluded.cover_url, publications.cover_url),
    doi = COALESCE(excluded.doi, publications.doi),
    isbn = COALESCE(excluded.isbn, publications.isbn),
    cited_by_count = MAX(excluded.cited_by_count, publications.cited_by_count),
    search_text = excluded.search_text,
    updated_at = datetime('now')
`;

/**
 * Insert-only variant used by anonymous-triggered paths (search cache): it can add new works
 * but NEVER overwrites a curated/harvested row.
 */
export const INSERT_NEW_PUBLICATION_SQL = UPSERT_PUBLICATION_SQL.replace(/ON CONFLICT\(id\) DO UPDATE SET[\s\S]*$/, 'ON CONFLICT DO NOTHING');

export function bindPublication(stmt: D1PreparedStatement, p: Publication): D1PreparedStatement {
  return stmt.bind(
    p.id,
    p.oaiIdentifier ?? p.id,
    p.title,
    p.subtitle ?? null,
    JSON.stringify(p.authors || []),
    p.publisher,
    p.country ?? 'Internacional',
    p.collection,
    p.collectionCode,
    p.year ?? null,
    p.publicationDate ?? null,
    p.language,
    p.docType,
    p.oecdArea,
    p.oecdAreaLabel,
    p.oecdSubarea ?? null,
    p.abstract || '',
    JSON.stringify(p.keywords || []),
    p.doi ?? null,
    p.isbn ?? null,
    p.scieloUrl,
    p.pdfUrl ?? null,
    p.epubUrl ?? null,
    p.coverUrl ?? null,
    p.pageCount ?? null,
    p.citedByCount ?? 0,
    p.sourceOrigin,
    p.rawSetSpec ?? null,
    buildSearchText(p)
  );
}

