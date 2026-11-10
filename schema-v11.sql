-- v11: notes_feeds —— 笔记推送到苹果备忘录（iOS 快捷指令单向推送）的取数凭证
CREATE TABLE IF NOT EXISTS notes_feeds (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
