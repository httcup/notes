-- v57：笔记本标记颜色（新建/重命名对话框里选，跟随账号同步）
ALTER TABLE notebooks ADD COLUMN color TEXT NOT NULL DEFAULT '';
