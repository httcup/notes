-- v3：笔记本支持删除（墓碑），与笔记一致的「后写覆盖」
ALTER TABLE notebooks ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
