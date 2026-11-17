-- v14：每个账号自己的 AI 接口配置（OpenAI 兼容）
--
-- 为什么不把 key 放前端：
--   1. key 一旦写进页面/本地缓存，任何拿到这台设备的人都能读走；
--   2. 多设备用户（Mac + 手机）不该每台重新填一遍；
--   3. 走服务端代理还能顺手挡掉内网地址，避免这个端被当成 SSRF 跳板。
--
-- key 不存明文：用 IVY_SECRET 派生的 AES-GCM 密钥加密后存 key_enc，
-- 接口只回掩码（sk-…abcd），前端永远拿不回原值；IVY_SECRET 换了就等于清空重填。
CREATE TABLE IF NOT EXISTS ai_config (
  user_id    TEXT PRIMARY KEY,
  base_url   TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  key_enc    TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
