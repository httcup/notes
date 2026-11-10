-- v7：给订阅源补一份「待办数组」，供提醒事项（VTODO）与快捷指令（JSON）复用
-- 远程与本地都已执行过；新环境直接跑 schema-v6.sql（里面已含 items 列）即可，不用重复执行这条
ALTER TABLE calendar_feeds ADD COLUMN items TEXT NOT NULL DEFAULT '[]';
