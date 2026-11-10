// /api/notesfeed  笔记 → 苹果备忘录（iOS 快捷指令单向推送）
//   GET （带登录）              查询自己是否已开启 / 拿到链接
//   POST {on:true}              开启或取回链接（幂等，token 不变）
//   POST {reset:true}           换一个链接（旧链接立即失效）
//   POST {off:true}             关闭，删除凭证
//   GET ?t=<token>              公开取数（快捷指令只调这一个）：
//                               &nb=笔记本名  只取某个笔记本
//                               &since=毫秒   只取这之后更新过的
//                               &limit=N      最多返回几篇（默认 100，上限 300）
import { json, preflight, currentUser, randomHex } from '../_lib.js';

const MAX_NOTES = 300;

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);
  const url = new URL(request.url);
  const origin = url.origin;

  /* ---- 公开取数：快捷指令拿 JSON ---- */
  const token = String(url.searchParams.get('t') || '').slice(0, 80);
  if (token) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const row = await env.DB
      .prepare('SELECT user_id FROM notes_feeds WHERE token = ?1')
      .bind(token)
      .first();
    if (!row) return json({ error: '链接无效或已关闭' }, 404);
    const uid = row.user_id;
    const nb = String(url.searchParams.get('nb') || '').trim().slice(0, 120);
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const limit = Math.min(MAX_NOTES, Math.max(1, Number(url.searchParams.get('limit')) || 100));

    const [notesRes, nbsRes] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM notes WHERE user_id = ?1').bind(uid),
      env.DB.prepare('SELECT * FROM notebooks WHERE user_id = ?1').bind(uid)
    ]);
    const nbName = new Map((nbsRes.results || []).map((r) => [r.id, r.name || '']));
    let notes = (notesRes.results || []).filter((r) => !r.trashed && !r.deleted);
    if (nb) {
      const ids = new Set((nbsRes.results || []).filter((r) => (r.name || '') === nb).map((r) => r.id));
      notes = notes.filter((r) => ids.has(r.notebook_id));
    }
    if (since) notes = notes.filter((r) => (r.updated_at || 0) > since);
    notes.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    const out = notes.slice(0, limit).map((r) => ({
      id: r.id,
      title: r.title || '无标题',
      body: r.body || '',
      notebook: nbName.get(r.notebook_id) || '',
      updatedAt: r.updated_at || 0,
      createdAt: r.created_at || 0
    }));
    return json({ ok: true, count: out.length, total: notes.length, notes: out, serverTime: Date.now() });
  }

  /* ---- 管理：需要登录 ---- */
  const user = await currentUser(request, env);
  if (!user) return json({ error: '口令不正确或登录已过期' }, 401);
  const uid = user.uid;

  try {
    if (request.method === 'GET') {
      const row = await env.DB
        .prepare('SELECT token FROM notes_feeds WHERE user_id = ?1')
        .bind(uid)
        .first();
      if (!row) return json({ on: false, token: '', url: '' });
      return json({ on: true, token: row.token, url: `${origin}/api/notesfeed?t=${row.token}` });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (body.off) {
        await env.DB.prepare('DELETE FROM notes_feeds WHERE user_id = ?1').bind(uid).run();
        return json({ on: false, token: '' });
      }
      const now = Date.now();
      const exist = await env.DB
        .prepare('SELECT token FROM notes_feeds WHERE user_id = ?1')
        .bind(uid)
        .first();
      const token = exist && !body.reset ? exist.token : randomHex(20);
      if (exist && !body.reset) {
        await env.DB.prepare('UPDATE notes_feeds SET updated_at = ?2 WHERE user_id = ?1').bind(uid, now).run();
      } else if (exist) {
        await env.DB
          .prepare('UPDATE notes_feeds SET token = ?2, updated_at = ?3 WHERE user_id = ?1')
          .bind(uid, token, now)
          .run();
      } else {
        await env.DB
          .prepare('INSERT INTO notes_feeds (token, user_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)')
          .bind(token, uid, now, now)
          .run();
      }
      return json({ on: true, token, url: `${origin}/api/notesfeed?t=${token}` });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
