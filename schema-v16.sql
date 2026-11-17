-- v16：笔记本支持二级（甚至更深）收纳 + 同级排序，并且跟着账号同步
-- parent_id 指向父笔记本的 id，NULL 表示一级；sort_order 是同一层里的顺序
ALTER TABLE notebooks ADD COLUMN parent_id TEXT;
ALTER TABLE notebooks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_notebooks_parent ON notebooks(user_id, parent_id);
