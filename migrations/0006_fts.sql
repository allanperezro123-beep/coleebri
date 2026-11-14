-- Coleebri 0006 — full-text index (FTS5) for large catalogues.
--
-- Why: D1 bills by rows READ. A LIKE '%x%' search scans the whole table (tens of thousands of
-- rows per query once Dialnet/DOAB/Redalyc are loaded). FTS5 answers from an inverted index.
-- `remove_diacritics 2` makes it accent-insensitive natively ("educacion" = "Educación").
--
-- External-content table over publications.search_text, kept in sync by triggers.
-- IMPORTANT: `wrangler d1 export` does not support databases with virtual tables. Use
-- `npm run db:backup:remote`, which drops this index, exports, and recreates it.

CREATE VIRTUAL TABLE IF NOT EXISTS publications_fts USING fts5(
  search_text,
  content = 'publications',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS publications_fts_ai AFTER INSERT ON publications BEGIN
  INSERT INTO publications_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS publications_fts_ad AFTER DELETE ON publications BEGIN
  INSERT INTO publications_fts(publications_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER IF NOT EXISTS publications_fts_au AFTER UPDATE OF search_text ON publications BEGIN
  INSERT INTO publications_fts(publications_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO publications_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

-- Index every existing row.
INSERT INTO publications_fts(publications_fts) VALUES ('rebuild');

-- Default listing ("solo texto completo", newest first) without a full scan.
CREATE INDEX IF NOT EXISTS idx_pub_fulltext_year
  ON publications(publication_year DESC, cited_by_count DESC)
  WHERE pdf_url IS NOT NULL AND pdf_url != '';
