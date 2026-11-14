-- Coleebri 0003 — Private, per-device shelves (security fix).
--
-- Before: `shelves` / `shelf_items` were global — every visitor could read, overwrite and
-- delete everybody else's shelves and notes (IDOR). Now every row is scoped by `owner_hash`,
-- the SHA-256 of an anonymous random key generated in the visitor's browser
-- (header X-Coleebri-Owner). No login is required and nobody can enumerate other owners.
--
-- The legacy global tables are left untouched (no data loss) but are no longer read or written.
-- They can be dropped manually once you have verified the new flow:
--   DROP TABLE shelf_items; DROP TABLE shelves;

CREATE TABLE IF NOT EXISTS owner_shelves (
  owner_hash TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  accent TEXT NOT NULL DEFAULT '#1758C4',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_hash, id)
);

CREATE TABLE IF NOT EXISTS owner_shelf_items (
  owner_hash TEXT NOT NULL,
  shelf_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  publication_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  reading_page INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_hash, shelf_id, publication_id)
);

CREATE INDEX IF NOT EXISTS idx_owner_items_owner ON owner_shelf_items(owner_hash, updated_at DESC);

-- Speeds up the lazy "resolve DOI → real PDF" write-back performed by /api/pdf-proxy.
CREATE INDEX IF NOT EXISTS idx_pub_scielo_url ON publications(scielo_url);
