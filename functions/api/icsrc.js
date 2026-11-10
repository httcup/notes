// /api/icsrc  苹果日历「订阅源」的账号级清单，让每台设备自动拿到同一个地址
//   GET             → { items:[{id,name,url,createdAt}] }
//   POST {name,url}  → 新增/更新（按 url 去重），返回 { id, items }
//   POST {remove:id} → 删除，返回 { items }
//   DELETE ?id=      → 同 remove
// 注意：这里只存「地址」，事件内容各设备自己去 /api/ics 拉，服务端不缓存解析结果
import { json, preflight, currentUser, randomHex } from '../_lib.js';

const MAX_URL = 600;

function norm(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (/^webcal:\/\//i.test(u)) u = u.replace(/^webcal:\/\//i, 'https://');
  if (/^\/\//.test(u)) u = 'https:' + u;
  if (!/^https?:\/\//i.test(u)) return '';
  try {
    const p = new URL(u);
    if (!p.hostname) return '';
    return p.toString().slice(0, MAX_URL);
  } catch (e) {
    return '';
  }
}

async function listAll(env, uid) {
  const { results } = await env.DB
    .prepare('SELECT id, name, url, created_at FROM ics_sources WHERE user_id = ?1 ORDER BY created_at ASC')
    .bind(uid)
    .all();
  return (results || []).map((r) => ({
    id: r.id,
    name: r.name || '苹果日历',
    url: r.url,
    createdAt: r.created_at || 0
  }));
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);

  const me = await currentUser(request, env);
  if (!me) return json({ error: '请先登录' }, 401);
  const uid = me.uid;

  if (request.method === 'GET') {
    return json({ items: await listAll(env, uid) });
  }

  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id') || '';
    if (id) await env.DB.prepare('DELETE FROM ics_sources WHERE user_id = ?1 AND id = ?2').bind(uid, id).run();
    return json({ items: await listAll(env, uid) });
  }

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const body = await request.json().catch(() => ({}));

  if (body.remove) {
    await env.DB.prepare('DELETE FROM ics_sources WHERE user_id = ?1 AND id = ?2')
      .bind(uid, String(body.remove))
      .run();
    return json({ items: await listAll(env, uid) });
  }

  const url = norm(body.url);
  if (!url) return json({ error: '链接要以 webcal:// 或 https:// 开头' }, 400);
  const name = String(body.name || '').trim().slice(0, 40) || '苹果日历';
  const now = Date.now();

  const exist = await env.DB
    .prepare('SELECT id FROM ics_sources WHERE user_id = ?1 AND url = ?2')
    .bind(uid, url)
    .first();

  if (exist) {
    await env.DB.prepare('UPDATE ics_sources SET name = ?1, updated_at = ?2 WHERE user_id = ?3 AND id = ?4')
      .bind(name, now, uid, exist.id)
      .run();
    return json({ id: exist.id, items: await listAll(env, uid) });
  }

  const id = 'c' + randomHex(6);
  await env.DB
    .prepare('INSERT INTO ics_sources (id, user_id, name, url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(id, uid, name, url, now, now)
    .run();
  return json({ id, items: await listAll(env, uid) });
}
