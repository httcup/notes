// /api/ai-config  每个账号自己的 AI 接口设置（OpenAI 兼容）
//
//   GET                 查当前配置：地址、模型、是否已存密钥（只回掩码）
//   POST {baseUrl,model,key}        保存；key 留空 = 保留原来的
//   POST {action:'test', baseUrl,key}  拿 /models 验证地址与密钥，顺便给模型下拉用
//   DELETE             清掉配置（密钥一起删）
//
// 刻意不提供「读取密钥」的接口：前端永远拿不回原值，
// 最多看到 sk-…abcd 这样的掩码，改了只能重填。
import { json, preflight, currentUser } from '../_lib.js';
import { normalizeBase, baseBlockReason, sealKey, loadAiConfig, maskKey } from '../_ai.js';

const MAX_BASE = 300;
const MAX_MODEL = 120;
const MAX_KEY = 400;

async function fetchModels(base, key) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(base + '/models', {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: ctl.signal
    });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 200);
      try {
        const j = JSON.parse(text);
        msg = (j.error && (j.error.message || j.error)) || j.message || msg;
      } catch (e) { /* 保持原文 */ }
      return { ok: false, error: '接口返回 HTTP ' + r.status + '：' + msg };
    }
    let list = [];
    try {
      const j = JSON.parse(text);
      list = (j.data || j.models || []).map((m) => (typeof m === 'string' ? m : (m.id || m.name || ''))).filter(Boolean);
    } catch (e) {
      return { ok: false, error: '返回的不是 JSON，可能不是 OpenAI 兼容接口' };
    }
    list = Array.from(new Set(list)).sort().slice(0, 200);
    return { ok: true, models: list };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, error: /abort/i.test(msg) ? '连接超时，检查地址能否访问' : ('连不上这个地址：' + msg.slice(0, 160)) };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);

  const user = await currentUser(request, env);
  if (!user) return json({ error: '登录后才能配置 AI 接口' }, 401);
  const uid = user.uid;

  try {
    if (request.method === 'GET') {
      const cfg = await loadAiConfig(env, uid);
      if (!cfg || !cfg.baseUrl) return json({ ok: true, configured: false });
      return json({
        ok: true,
        configured: !!(cfg.baseUrl && cfg.model && cfg.key),
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        hasKey: !!cfg.keyEnc,
        keyMask: cfg.broken ? '' : maskKey(cfg.key),
        keyBroken: cfg.broken,
        updatedAt: cfg.updatedAt
      });
    }

    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM ai_config WHERE user_id = ?1').bind(uid).run();
      return json({ ok: true, configured: false });
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const body = await request.json().catch(() => ({}));
    const baseUrl = normalizeBase(body.baseUrl).slice(0, MAX_BASE);
    const model = String(body.model || '').trim().slice(0, MAX_MODEL);
    const newKey = String(body.key || '').trim().slice(0, MAX_KEY);

    if (!baseUrl) return json({ error: '请填写服务地址，例如 https://api.deepseek.com' }, 400);
    const block = baseBlockReason(baseUrl);
    if (block) return json({ error: block }, 400);

    const existing = await loadAiConfig(env, uid);
    const key = newKey || (existing && existing.key) || '';

    // 只验证不保存：给「拉取模型」按钮用，不写库
    if (String(body.action || '') === 'test') {
      if (!key) return json({ error: '先填 API Key，或用已经保存过的' }, 400);
      const r = await fetchModels(baseUrl, key);
      if (!r.ok) return json({ error: r.error }, 400);
      return json({ ok: true, models: r.models });
    }

    if (!model) return json({ error: '请填写模型名，例如 deepseek-v4-flash' }, 400);
    if (!key) return json({ error: '请填写 API Key' }, 400);

    let keyEnc = existing && existing.keyEnc && !newKey ? existing.keyEnc : '';
    if (!keyEnc) {
      try { keyEnc = await sealKey(env, key); }
      catch (e) { return json({ error: String((e && e.message) || e).slice(0, 160) }, 503); }
    }

    await env.DB.prepare(
      `INSERT INTO ai_config (user_id, base_url, model, key_enc, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id) DO UPDATE SET base_url = ?2, model = ?3, key_enc = ?4, updated_at = ?5`
    ).bind(uid, baseUrl, model, keyEnc, Date.now()).run();

    return json({ ok: true, configured: true, baseUrl, model, hasKey: true, keyMask: maskKey(key) });
  } catch (err) {
    return json({ error: String((err && err.message) || err).slice(0, 200) }, 500);
  }
}
