// /api/share  公开分享
//   POST           （需登录）为某篇笔记创建/刷新分享快照，返回 slug
//   GET  ?slug=xx  （公开）读取分享内容
//   DELETE ?noteId=xx | ?slug=xx （需登录）取消分享
import { json, preflight, currentUser, randomHex } from '../_lib.js';

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库（变量名 DB）' }, 503);

  const url = new URL(request.url);

  // —— 公开读取，不需要登录 ——
  if (request.method === 'GET') {
    const slug = str(url.searchParams.get('slug'), 64).replace(/[^a-zA-Z0-9]/g, '');
    if (!slug) return json({ error: '缺少 slug' }, 400);
    try {
      const row = await env.DB
        .prepare('SELECT title, body, created_at, updated_at FROM shares WHERE slug = ?1')
        .bind(slug)
        .first();
      if (!row) return json({ error: '分享不存在或已取消' }, 404);
      return json({
        slug,
        title: row.title || '',
        body: row.body || '',
        createdAt: row.created_at || 0,
        updatedAt: row.updated_at || 0
      });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }

  const user = await currentUser(request, env);
  if (!user) return json({ error: '请先登录' }, 401);
  const uid = user.uid;

  // —— 创建 / 刷新快照 ——
  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const noteId = str(body.noteId, 80);
    if (!noteId) return json({ error: '缺少 noteId' }, 400);
    const title = str(body.title, 300);
    const content = typeof body.body === 'string' ? body.body.slice(0, 400000) : '';
    const now = Date.now();

    try {
      const exist = await env.DB
        .prepare('SELECT slug FROM shares WHERE user_id = ?1 AND note_id = ?2')
        .bind(uid, noteId)
        .first();

      if (exist) {
        await env.DB
          .prepare('UPDATE shares SET title = ?1, body = ?2, updated_at = ?3 WHERE slug = ?4')
          .bind(title, content, now, exist.slug)
          .run();
        return json({ slug: exist.slug, created: false, updatedAt: now });
      }

      const slug = randomHex(6);
      await env.DB
        .prepare('INSERT INTO shares (slug, user_id, note_id, title, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
        .bind(slug, uid, noteId, title, content, now, now)
        .run();
      return json({ slug, created: true, updatedAt: now });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }

  // —— 取消分享 ——
  if (request.method === 'DELETE') {
    const noteId = str(url.searchParams.get('noteId'), 80);
    const slug = str(url.searchParams.get('slug'), 64).replace(/[^a-zA-Z0-9]/g, '');
    if (!noteId && !slug) return json({ error: '缺少 noteId 或 slug' }, 400);
    try {
      const st = noteId
        ? await env.DB.prepare('DELETE FROM shares WHERE user_id = ?1 AND note_id = ?2').bind(uid, noteId).run()
        : await env.DB.prepare('DELETE FROM shares WHERE user_id = ?1 AND slug = ?2').bind(uid, slug).run();
      return json({ ok: true, deleted: (st.meta && st.meta.changes) || 0 });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }

  return json({ error: 'Method not allowed' }, 405);
}
