-- 笔记历史版本：每次编辑留一份快照，按保留策略清理
CREATE TABLE IF NOT EXISTS note_versions (
  user_id    TEXT NOT NULL DEFAULT 'owner',
  id         TEXT NOT NULL,
  note_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_versions_note
  ON note_versions (user_id, note_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_versions_age
  ON note_versions (user_id, created_at);
