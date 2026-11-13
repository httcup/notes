-- v13：站主设置表（键值对），当前只存「开放注册」开关
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
-- 默认开放注册；关掉后新用户注册会被拒绝，提示联系管理员
INSERT INTO settings (k, v, updated_at) VALUES ('reg_open', '1', 0)
  ON CONFLICT(k) DO NOTHING;
