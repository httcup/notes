-- v8：苹果日历订阅源（跨设备同步用）
-- 只存「哪些公开日历被加进来了」，事件本体各设备自己拉、自己解析，不落库
CREATE TABLE IF NOT EXISTS ics_sources (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '苹果日历',
  url        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ics_sources_url ON ics_sources(user_id, url);
CREATE INDEX IF NOT EXISTS idx_ics_sources_user ON ics_sources(user_id);
