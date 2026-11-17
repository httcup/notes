// /api/tokens  API 令牌管理（给 MCP 客户端用）
//
//   GET             列出我发出的令牌（只给前缀，不返回明文）
//   POST { name }   新建令牌，明文只在这里返回一次
//   DELETE ?id=xxx  吊销（软删，留审计）
//
// 令牌形如 ivy_pat_xxxxxxxx；库里只存 SHA-256，泄库也拿不到可用的钥匙。
import { json, preflight, currentUser } from '../_lib.js';

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randToken(n = 24) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);

  const user = await currentUser(request, env);
  if (!user) return json({ error: '请先登录再管理 API 令牌' }, 401);
  const uid = user.uid;

  try {
    if (request.method === 'GET') {
      const res = await env.DB.prepare(
        'SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ?1 AND revoked = 0 ORDER BY created_at DESC LIMIT 50'
      ).bind(uid).all();
      return json({
        ok: true,
        tokens: (res.results || []).map((r) => ({
          id: r.id,
          name: r.name || '',
          prefix: r.prefix || '',
          createdAt: r.created_at || 0,
          lastUsedAt: r.last_used_at || 0
        }))
      });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const name = str(body.name, 40).trim() || '未命名令牌';
      const token = 'ivy_pat_' + randToken(24);
      const id = 'tk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await env.DB.prepare(
        'INSERT INTO api_tokens (id, user_id, name, hash, prefix, created_at, last_used_at, revoked) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0)'
      ).bind(id, uid, name, await sha256hex(token), token.slice(0, 16), Date.now()).run();
      // 明文只在这个响应里出现一次，之后任何接口都查不到
      return json({ ok: true, id, name, token, prefix: token.slice(0, 16) });
    }

    if (request.method === 'DELETE') {
      const u = new URL(request.url);
      const id = str(u.searchParams.get('id'), 60);
      if (!id) return json({ error: '缺少令牌 id' }, 400);
      await env.DB.prepare('UPDATE api_tokens SET revoked = 1 WHERE user_id = ?1 AND id = ?2')
        .bind(uid, id).run();
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: '服务暂时不可用：' + (e && e.message ? e.message : '未知错误') }, 424);
  }
}
