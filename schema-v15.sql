-- API 令牌：给 Claude / Cursor 等 MCP 客户端读写笔记用
-- 只存 SHA-256 摘要，明文只在创建时返回一次
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  hash         TEXT NOT NULL,
  prefix       TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  revoked      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_hash ON api_tokens(hash);
