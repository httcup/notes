-- v2：多账号 + 按账号隔离的数据
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);

-- notes：加 user_id，主键改为 (user_id, id)
CREATE TABLE IF NOT EXISTS notes_v2 (
  user_id     TEXT NOT NULL DEFAULT 'owner',
  id          TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  notebook_id TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  trashed     INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

INSERT OR IGNORE INTO notes_v2 (user_id, id, title, body, notebook_id, tags, trashed, deleted, created_at, updated_at)
  SELECT 'owner', id, title, body, notebook_id, tags, trashed, deleted, created_at, updated_at FROM notes;

DROP TABLE IF EXISTS notes;
ALTER TABLE notes_v2 RENAME TO notes;
CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON notes(user_id, updated_at);

-- notebooks：同理
CREATE TABLE IF NOT EXISTS notebooks_v2 (
  user_id    TEXT NOT NULL DEFAULT 'owner',
  id         TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  open       INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

INSERT OR IGNORE INTO notebooks_v2 (user_id, id, name, open, updated_at)
  SELECT 'owner', id, name, open, updated_at FROM notebooks;

DROP TABLE IF EXISTS notebooks;
ALTER TABLE notebooks_v2 RENAME TO notebooks;
