// POST /api/auth  登录 / 注册，换一个 90 天有效的令牌
import { json, preflight, hashPassword, randomHex, signToken, safeEqual } from '../_lib.js';

const TTL = 90 * 864e5;

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);

  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const key = String(body.key || '');
  if (key.length < 4) return json({ error: '口令至少 4 位' }, 400);

  // 留空账号 = 主人账号，沿用环境变量里的口令
  if (!name) {
    if (!env.IVY_KEY) return json({ error: '服务端未配置 IVY_KEY' }, 503);
    if (!safeEqual(key, env.IVY_KEY)) return json({ error: '口令不正确' }, 401);
    const token = await signToken({ u: 'owner', n: '主人', e: Date.now() + TTL }, env.IVY_SECRET);
    return json({ token, name: '主人', uid: 'owner' });
  }

  if (!/^[\w\u4e00-\u9fa5.-]{2,24}$/.test(name)) {
    return json({ error: '账号 2-24 位，可用中英文、数字、_ . -' }, 400);
  }
  if (!env.IVY_SECRET) return json({ error: '服务端未配置 IVY_SECRET' }, 503);

  const row = await env.DB.prepare('SELECT id, name, salt, hash, disabled FROM users WHERE name = ?1')
    .bind(name)
    .first();

  if (row) {
    const h = await hashPassword(key, row.salt);
    if (!safeEqual(h, row.hash)) return json({ error: '口令不正确' }, 401);
    if (row.disabled) return json({ error: '该账号已被停用，请联系站主' }, 403);
    const token = await signToken({ u: row.id, n: row.name, e: Date.now() + TTL }, env.IVY_SECRET);
    return json({ token, name: row.name, uid: row.id });
  }

  if (!body.create) return json({ error: '账号不存在，可以点「注册」新建' }, 404);

  const id = 'u' + randomHex(8);
  const salt = randomHex(16);
  const hash = await hashPassword(key, salt);
  await env.DB.prepare('INSERT INTO users (id, name, salt, hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, name, salt, hash, Date.now())
    .run();
  const token = await signToken({ u: id, n: name, e: Date.now() + TTL }, env.IVY_SECRET);
  return json({ token, name, uid: id, created: true });
}
