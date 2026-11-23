-- v19：日历事件（苹果日历的镜像）
--
-- 为什么要有这张表：网页端在浏览器里没法直接读 macOS / iOS 的日历，
-- 所以由 Mac 端脚本把事件推上来，前端读这份快照。
-- 一条事件用苹果日历给出的 UID 做主键的一部分，重复同步只更新、不重复插入。
CREATE TABLE IF NOT EXISTS calendar_events (
  user_id    TEXT NOT NULL,          -- 账号
  uid        TEXT NOT NULL,          -- 事件在苹果日历里的唯一标识（跨设备稳定）
  cal        TEXT,                   -- 所属日历名，如「工作」「个人」
  color      TEXT,                   -- 日历颜色 #rrggbb
  title      TEXT,
  start      INTEGER NOT NULL DEFAULT 0,   -- 毫秒时间戳
  end        INTEGER NOT NULL DEFAULT 0,
  all_day    INTEGER NOT NULL DEFAULT 0,   -- 1 = 全天
  location   TEXT,
  notes      TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, uid)
);

-- 按时间窗取事件是唯一的读法
CREATE INDEX IF NOT EXISTS idx_cal_events_range ON calendar_events (user_id, start, end);
