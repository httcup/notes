// /api/versions  笔记历史版本：列表 / 取单条 / 存新版本
import { json, preflight, currentUser } from '../_lib.js';

const KEEP_DAYS = 30;                 // 服务器保留期
const MAX_PER_NOTE = 400;             // 单篇最多留这么多条

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();

  const user = await currentUser(request, env);
  if (!user) return json({ error: '口令不正确或登录已过期' }, 401);
  if (!env.DB) return json({ error: '还没绑定 D1 数据库（变量名 DB）' }, 503);

  const uid = user.uid;
  const url = new URL(request.url);

  try {
    if (request.method === 'GET') {
      const vid = url.searchParams.get('id');
      if (vid) {
        const row = await env.DB
          .prepare('SELECT id, note_id, title, body, created_at FROM note_versions WHERE user_id = ?1 AND id = ?2')
          .bind(uid, String(vid).slice(0, 80))
          .first();
        if (!row) return json({ error: '这个版本已经不在服务器上了' }, 404);
        return json({
          version: {
            id: row.id, noteId: row.note_id, title: row.title || '',
            body: row.body || '', at: row.created_at || 0
          }
        });
      }

      const noteId = url.searchParams.get('noteId') || '';
      if (!noteId) return json({ versions: [] });
      const rows = await env.DB
        .prepare(`SELECT id, note_id, title, length(body) AS size, created_at
                  FROM note_versions WHERE user_id = ?1 AND note_id = ?2
                  ORDER BY created_at DESC LIMIT ${MAX_PER_NOTE}`)
        .bind(uid, String(noteId).slice(0, 80))
        .all();
      return json({
        versions: (rows.results || []).map((r) => ({
          id: r.id, noteId: r.note_id, title: r.title || '',
          size: r.size || 0, at: r.created_at || 0
        }))
      });
    }

    if (request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const noteId = typeof b.noteId === 'string' ? b.noteId.slice(0, 80) : '';
      if (!noteId) return json({ error: '缺少 noteId' }, 400);

      const id = (typeof b.id === 'string' && b.id ? b.id : 'v' + Date.now().toString(36)).slice(0, 80);
      const at = Number(b.at) || Date.now();
      const title = String(b.title || '').slice(0, 500);
      const body = typeof b.body === 'string' ? b.body.slice(0, 400000) : '';

      await env.DB
        .prepare(`INSERT INTO note_versions (user_id, id, note_id, title, body, created_at)
                  VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                  ON CONFLICT(user_id, id) DO NOTHING`)
        .bind(uid, id, noteId, title, body, at)
        .run();

      // 清过期 + 控制单篇条数
      const cutoff = Date.now() - KEEP_DAYS * 86400000;
      await env.DB
        .prepare('DELETE FROM note_versions WHERE user_id = ?1 AND created_at < ?2')
        .bind(uid, cutoff)
        .run();
      await env.DB
        .prepare(`DELETE FROM note_versions WHERE user_id = ?1 AND note_id = ?2 AND id NOT IN (
                    SELECT id FROM note_versions WHERE user_id = ?1 AND note_id = ?2
                    ORDER BY created_at DESC LIMIT ${MAX_PER_NOTE})`)
        .bind(uid, noteId)
        .run();

      return json({ ok: true, id });
    }

    if (request.method === 'DELETE') {
      const vid = url.searchParams.get('id') || '';
      const noteId = url.searchParams.get('noteId') || '';
      if (vid) {
        await env.DB.prepare('DELETE FROM note_versions WHERE user_id = ?1 AND id = ?2')
          .bind(uid, String(vid).slice(0, 80)).run();
      } else if (noteId) {
        await env.DB.prepare('DELETE FROM note_versions WHERE user_id = ?1 AND note_id = ?2')
          .bind(uid, String(noteId).slice(0, 80)).run();
      }
      return json({ ok: true });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ error: String((e && e.message) || e).slice(0, 200) }, 500);
  }
}
