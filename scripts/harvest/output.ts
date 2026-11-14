/**
 * Output stage: Rec → Publication (via the server's own sanitizer), D1 seed chunks,
 * country backfill for the legacy seed, featured fallback catalog.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sanitizePublication } from '../../functions/publications';
import { inferCountry, classifyOecdArea } from '../../src/lib/taxonomy';
import type { Publication } from '../../src/types/publication';
import { ROOT_DIR } from './cache';
import { fullTextPdf, languageCode, scieloCover, squash, type Rec } from './model';

/* ------------------------------ Rec → Publication ------------------------------ */

export function recordId(r: Rec): string | null {
  if (r.scieloId && r.docType === 'book') return `scielo-book-${r.scieloId}`;
  if (r.openalexId) return `oa-${r.openalexId}`;
  if (r.docType === 'article' && r.externalId) return `scielo-art-${r.externalId.replace(/[^A-Za-z0-9]/g, '').slice(0, 100)}`;
  if (r.doi) return `cr-${r.doi.replace(/[^a-z0-9]/g, '')}`.slice(0, 118);
  return null;
}

function oaiIdentifier(r: Rec, id: string): string {
  if (r.scieloId && r.docType === 'book') return r.scieloId;
  if (r.openalexId) return `https://openalex.org/${r.openalexId}`;
  return r.externalId || r.doi || id;
}

export function toPublication(r: Rec): { pub?: Publication; reason?: string } {
  const id = recordId(r);
  if (!id) return { reason: 'no-id' };
  const area = classifyOecdArea({
    title: r.title,
    abstract: r.abstract,
    keywords: r.keywords,
    publisher: r.publisher,
    openAlexDomainId: r.domainId,
    openAlexFieldName: r.fieldName
  });
  const hasScielo = Boolean(r.scieloId);
  const collection = r.collection || (hasScielo ? 'SciELO Books' : 'Red SciELO');
  const collectionCode = r.collectionCode || (hasScielo ? 'books' : 'scielo-network');
  const pdfUrl = fullTextPdf(r.pdfUrl);
  const isbn = r.isbns[0];
  const country = inferCountry({
    collection,
    collectionCode,
    scieloUrl: r.scieloUrl,
    pdfUrl,
    publisher: r.publisher,
    isbn: r.isbns.join(';')
  });
  const sourceOrigin: Publication['sourceOrigin'] =
    r.docType === 'article' ? 'oai-pmh' : r.origins.length === 1 && r.origins[0] === 'opds' ? 'opds' : 'openalex';

  const clean = sanitizePublication({
    id,
    oaiIdentifier: oaiIdentifier(r, id),
    title: squash(r.title),
    subtitle: r.subtitle ? squash(r.subtitle) : undefined,
    authors: r.authors,
    publisher: r.publisher ? squash(r.publisher) : undefined,
    country,
    collection,
    collectionCode,
    year: r.year ?? null,
    publicationDate: r.publicationDate,
    language: languageCode(r.language),
    docType: r.docType,
    oecdArea: area.area,
    oecdSubarea: area.subarea,
    abstract: squash(r.abstract),
    keywords: r.keywords,
    doi: r.doi,
    isbn,
    scieloUrl: r.scieloUrl,
    pdfUrl,
    epubUrl: r.epubUrl,
    coverUrl: r.coverUrl || (r.scieloId && r.docType === 'book' ? scieloCover(r.scieloId) : undefined),
    pageCount: r.pageCount,
    citedByCount: r.cited,
    sourceOrigin
  });
  if (!clean) return { reason: 'sanitizer-rejected' };
  // The sanitizer only sees the primary ISBN; keep the richer inference (all ISBNs) we computed.
  clean.country = country;
  clean.pdfUrl = fullTextPdf(clean.pdfUrl);
  return { pub: clean };
}

/* ------------------------------------ SQL ------------------------------------ */

export const COLUMNS = [
  'id', 'oai_identifier', 'title', 'subtitle', 'authors_json', 'publisher', 'country',
  'collection', 'collection_code', 'publication_year', 'publication_date',
  'language', 'doc_type', 'oecd_area', 'oecd_area_label', 'oecd_subarea',
  'abstract', 'keywords_json', 'doi', 'isbn', 'scielo_url', 'pdf_url',
  'epub_url', 'cover_url', 'page_count', 'cited_by_count', 'source_origin', 'raw_set_spec'
] as const;

export function lit(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.trunc(v)) : 'NULL';
  // SQLite only needs ' doubled; NULs/newlines were already stripped from every text field
  return `'${v.replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

/** Mirrors functions/publications.ts UPSERT_PUBLICATION_SQL (+ language/year/page_count never lose data). */
const CONFLICT = `ON CONFLICT(id) DO UPDATE SET
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
    language = CASE WHEN excluded.language != 'other' THEN excluded.language ELSE publications.language END,
    publication_year = COALESCE(publications.publication_year, excluded.publication_year),
    page_count = COALESCE(publications.page_count, excluded.page_count),
    updated_at = datetime('now')`.replace(/\n\s+/g, ' ');

const MAX_STATEMENT_BYTES = 90_000;

export function insertStatement(p: Publication): string {
  const build = (abstract: string) => {
    const values = [
      lit(p.id), lit(p.oaiIdentifier ?? p.id), lit(p.title), lit(p.subtitle ?? null),
      lit(JSON.stringify(p.authors || [])), lit(p.publisher), lit(p.country ?? 'Internacional'),
      lit(p.collection), lit(p.collectionCode), lit(p.year ?? null), lit(p.publicationDate ?? null),
      lit(p.language), lit(p.docType), lit(p.oecdArea), lit(p.oecdAreaLabel), lit(p.oecdSubarea ?? null),
      lit(abstract), lit(JSON.stringify(p.keywords || [])), lit(p.doi ?? null), lit(p.isbn ?? null),
      lit(p.scieloUrl), lit(p.pdfUrl ?? null), lit(p.epubUrl ?? null), lit(p.coverUrl ?? null),
      lit(p.pageCount ?? null), lit(p.citedByCount ?? 0), lit(p.sourceOrigin), lit(p.rawSetSpec ?? null)
    ];
    return `INSERT INTO publications (${COLUMNS.join(', ')}, updated_at) VALUES (${values.join(', ')}, datetime('now')) ${CONFLICT};`;
  };
  let abstract = p.abstract || '';
  let sql = build(abstract);
  while (Buffer.byteLength(sql) > MAX_STATEMENT_BYTES && abstract.length > 200) {
    abstract = abstract.slice(0, Math.floor(abstract.length * 0.8));
    sql = build(abstract);
  }
  return sql;
}

export function writeSeedChunks(pubs: Publication[], dir: string, chunkSize = 200): { files: string[]; maxStatementBytes: number } {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^seed_\d+\.sql$/.test(f)) fs.rmSync(path.join(dir, f));
  const files: string[] = [];
  let maxBytes = 0;
  for (let i = 0; i < pubs.length; i += chunkSize) {
    const lines = pubs.slice(i, i + chunkSize).map((p) => {
      const s = insertStatement(p);
      maxBytes = Math.max(maxBytes, Buffer.byteLength(s));
      return s;
    });
    const name = `seed_${String(files.length + 1).padStart(3, '0')}.sql`;
    fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n', 'utf8');
    files.push(name);
  }
  return { files, maxStatementBytes: maxBytes };
}

/* --------------------------- legacy seed → country backfill --------------------------- */

type SqlValue = string | number | null;

function parseInsertLine(line: string): Record<string, SqlValue> | null {
  const colsMatch = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+publications\s*\(([^)]*)\)\s*VALUES\s*\(/i.exec(line);
  if (!colsMatch) return null;
  const cols = colsMatch[1].split(',').map((c) => c.trim());
  const vals: SqlValue[] = [];
  let i = colsMatch[0].length;
  while (i < line.length && vals.length < cols.length) {
    while (line[i] === ' ' || line[i] === ',') i += 1;
    if (line[i] === "'") {
      let s = '';
      i += 1;
      for (; i < line.length; i += 1) {
        if (line[i] === "'") {
          if (line[i + 1] === "'") {
            s += "'";
            i += 1;
          } else break;
        } else s += line[i];
      }
      i += 1;
      vals.push(s);
    } else {
      let j = i;
      while (j < line.length && line[j] !== ',' && line[j] !== ')') j += 1;
      const tok = line.slice(i, j).trim();
      vals.push(/^null$/i.test(tok) ? null : Number(tok));
      i = j;
    }
  }
  if (vals.length !== cols.length) return null;
  return Object.fromEntries(cols.map((c, k) => [c, vals[k]]));
}

function stripLeadingComments(stmt: string): string {
  const lines = stmt.trim().split('\n');
  while (lines.length && /^\s*--/.test(lines[0])) lines.shift();
  return lines.join('\n').trim();
}

/** Splits SQL text into statements on ';' outside single-quoted literals (legacy abstracts contain newlines). */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of text) {
    if (ch === "'") inQuote = !inQuote;
    if (ch === ';' && !inQuote) {
      if (cur.trim()) out.push(stripLeadingComments(cur));
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(stripLeadingComments(cur));
  return out;
}

export function buildCountryBackfill(): { sql: string; total: number; updated: number; byCountry: Record<string, number> } {
  const seedPath = path.join(ROOT_DIR, 'migrations', '0002_seed.sql');
  const rows = splitStatements(fs.readFileSync(seedPath, 'utf8'))
    .map(parseInsertLine)
    .filter((r): r is Record<string, SqlValue> => r !== null);
  const lines: string[] = [
    '-- Coleebri 0004 — country backfill for the legacy seed rows (0002_seed.sql never wrote `country`).',
    '-- Generated by scripts/harvest (npm run harvest) with src/lib/taxonomy.ts inferCountry(). Idempotent:',
    "-- only rows still marked 'Internacional' are touched, so re-running or running after the chunks is safe."
  ];
  const byCountry: Record<string, number> = {};
  let updated = 0;
  for (const r of rows) {
    const country = inferCountry({
      isbn: (r.isbn as string) || undefined,
      scieloUrl: r.scielo_url as string,
      pdfUrl: (r.pdf_url as string) || undefined,
      publisher: r.publisher as string,
      collection: r.collection as string,
      collectionCode: r.collection_code as string
    });
    byCountry[country] = (byCountry[country] || 0) + 1;
    if (country === 'Internacional') continue;
    lines.push(`UPDATE publications SET country = ${lit(country)} WHERE id = ${lit(r.id as string)} AND country = 'Internacional';`);
    updated += 1;
  }
  return { sql: lines.join('\n') + '\n', total: rows.length, updated, byCountry };
}

/** ids of the legacy seed (to avoid UNIQUE(oai_identifier) clashes with different ids). */
export function legacySeedOai(): Map<string, string> {
  const seedPath = path.join(ROOT_DIR, 'migrations', '0002_seed.sql');
  const map = new Map<string, string>();
  for (const stmt of splitStatements(fs.readFileSync(seedPath, 'utf8'))) {
    const r = parseInsertLine(stmt);
    if (r?.oai_identifier) map.set(r.oai_identifier as string, r.id as string);
  }
  return map;
}

/* -------------------------------------- featured -------------------------------------- */

export function pickFeaturedCandidates(pubs: Publication[], want: number): Publication[] {
  const pool = pubs
    .filter((p) => p.pdfUrl && p.docType === 'book' && p.year && p.abstract.length >= 120 && p.authors.length > 0)
    .sort((a, b) => (b.citedByCount ?? 0) - (a.citedByCount ?? 0));
  const picked: Publication[] = [];
  const seen = new Set<string>();
  const take = (p: Publication) => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    picked.push(p);
  };
  // 1) every Colombian record we can (up to a third of the list)
  for (const p of pool.filter((x) => x.country === 'Colombia').slice(0, Math.ceil(want / 3))) take(p);
  // 2) round-robin over country → (language, area) buckets for diversity
  const byCountry = new Map<string, Publication[]>();
  for (const p of pool) {
    const k = p.country || 'Internacional';
    if (!byCountry.has(k)) byCountry.set(k, []);
    byCountry.get(k)!.push(p);
  }
  const usedCombo = new Set(picked.map((p) => `${p.country}|${p.language}|${p.oecdArea}`));
  const perCountryCap = Math.max(6, Math.ceil(want / 4));
  const taken = new Map<string, number>();
  for (const p of picked) taken.set(p.country || '', (taken.get(p.country || '') || 0) + 1);
  for (let round = 0; round < 60 && picked.length < want; round += 1) {
    for (const [country, list] of [...byCountry.entries()].sort((a, b) => b[1].length - a[1].length)) {
      if (picked.length >= want) break;
      if ((taken.get(country) || 0) >= perCountryCap) continue;
      const next = list.find((p) => !seen.has(p.id) && (round > 1 || !usedCombo.has(`${p.country}|${p.language}|${p.oecdArea}`)));
      if (!next) continue;
      usedCombo.add(`${next.country}|${next.language}|${next.oecdArea}`);
      taken.set(country, (taken.get(country) || 0) + 1);
      take(next);
    }
  }
  // 3) if per-country caps left us short, top up with the most cited remaining records
  for (const p of pool) {
    if (picked.length >= want) break;
    take(p);
  }
  return picked;
}
