-- v6：日历订阅源（把带时间的待办做成一个可被日历 App 反复拉取的 .ics）
-- 内容由网页端解析后上传，服务端只负责存与发，避免两套解析逻辑算错时间
CREATE TABLE IF NOT EXISTS calendar_feeds (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  ics        TEXT NOT NULL DEFAULT '',
  count      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feeds_user ON calendar_feeds(user_id);
