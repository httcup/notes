-- 账号级的零散状态（目前装的是「待办归档」列表）：整块 JSON 存，按 updated_at 后写覆盖。
-- 以前这类状态只放在本机，换设备就没了。
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
