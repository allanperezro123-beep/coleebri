-- Coleebri 0005 — accent/case-insensitive search.
-- SQLite LIKE only folds ASCII case, so "educacion" never matched "Educación".
-- `search_text` holds a folded (lowercase, no diacritics) copy of title/authors/publisher/
-- keywords/abstract. New writes fill it automatically (functions/publications.ts); existing
-- rows are filled by `npm run db:reindex:<local|remote>` (scripts/reindex-publications.ts).
-- Rows with NULL search_text still match through the raw-column fallback in the API.

ALTER TABLE publications ADD COLUMN search_text TEXT;
