-- v18：笔记本密码锁（存盐值和校验值，正文本身不动）
ALTER TABLE notebooks ADD COLUMN lock TEXT;
