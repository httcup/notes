-- ivyNote 云同步数据表
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  notebook_id TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  trashed     INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);

CREATE TABLE IF NOT EXISTS notebooks (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  open       INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 每日用量（长图配额计数）：一条 UPSERT ... RETURNING 就能原子地占位并取回已用数
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  kind    TEXT NOT NULL,
  used    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);
