-- Undertone 資料庫結構。第一次部署前執行一次：
--   npx wrangler d1 execute undertone --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS docs_by_time ON docs (collection, created_at);

CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
