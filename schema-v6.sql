-- v6：待办对外的订阅源（一个 token，三种产物：日历 ics / 提醒事项 vtodo / 快捷指令 json）
-- 内容由网页端解析后上传，服务端只负责存与发，避免两套解析逻辑算错时间
CREATE TABLE IF NOT EXISTS calendar_feeds (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  ics        TEXT NOT NULL DEFAULT '',
  items      TEXT NOT NULL DEFAULT '[]',
  count      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feeds_user ON calendar_feeds(user_id);
