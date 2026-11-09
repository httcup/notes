-- v4：公开分享链接（只读快照，按 slug 访问）
CREATE TABLE IF NOT EXISTS shares (
  slug       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  note_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_owner_note ON shares(user_id, note_id);
