-- VIP：到期时间（毫秒时间戳），0 表示不是 VIP
-- 权益：图床/云端上传不占白名单限制、站内 AI 不限次数
ALTER TABLE users ADD COLUMN vip_until INTEGER NOT NULL DEFAULT 0;
