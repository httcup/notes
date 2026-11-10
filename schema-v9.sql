-- v9：苹果日历事件的「已勾选」状态（只在本应用里记，不回写日历）
-- key = <事件 UID>|<开始时间戳>，按发生的那一次算，重复日程每次独立
CREATE TABLE IF NOT EXISTS ics_done (
  user_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_ics_done_user ON ics_done(user_id);
