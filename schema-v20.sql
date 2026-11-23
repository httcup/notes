-- v20：iCloud CalDAV 连接（双向同步苹果日历）
--
-- 为什么单独一张表：Apple ID 和「App 专用密码」要加密后放服务端，
-- 才能让 Worker 直接读写 iCloud 日历（浏览器里做不到）。
-- secret 是 AES-GCM 密文（key 由 IVY_SECRET 派生），永远不回传前端。
CREATE TABLE IF NOT EXISTS caldav_config (
  user_id    TEXT PRIMARY KEY,
  apple_id   TEXT NOT NULL,
  secret     TEXT NOT NULL,          -- base64(iv + 密文)
  principal  TEXT,                   -- current-user-principal
  home       TEXT,                   -- calendar-home-set
  calendars  TEXT,                   -- JSON: [{href,name,color,on}]
  last_sync  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 事件从「苹果日历」同步回来时要知道怎么写回去：href 是它在 CalDAV 里的路径，etag 用来防并发覆盖
ALTER TABLE calendar_events ADD COLUMN href TEXT;
ALTER TABLE calendar_events ADD COLUMN etag TEXT;
