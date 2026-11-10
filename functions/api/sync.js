// /api/sync  按账号隔离的双向同步（updatedAt 后写覆盖）
import { json, preflight, currentUser } from '../_lib.js';

function safeTags(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 20) : [];
  } catch (e) {
    return [];
  }
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

async function readAll(env, uid) {
  const [notesRes, nbsRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM notes WHERE user_id = ?1').bind(uid),
    env.DB.prepare('SELECT * FROM notebooks WHERE user_id = ?1').bind(uid)
  ]);
  const notes = (notesRes.results || []).map((r) => ({
    id: r.id,
    title: r.title || '',
    body: r.body || '',
    notebookId: r.notebook_id || null,
    tags: safeTags(r.tags),
    trashed: !!r.trashed,
    deleted: !!r.deleted,
    createdAt: r.created_at || 0,
    updatedAt: r.updated_at || 0
  }));
  const notebooks = (nbsRes.results || []).map((r) => ({
    id: r.id,
    name: r.name || '',
    color: r.color || '',
    open: !!r.open,
    deleted: !!r.deleted,
    updatedAt: r.updated_at || 0
  }));
  return { notes, notebooks, serverTime: Date.now() };
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();

  const user = await currentUser(request, env);
  if (!user) return json({ error: '口令不正确或登录已过期' }, 401);
  if (!env.DB) return json({ error: '还没绑定 D1 数据库（变量名 DB）' }, 503);

  const uid = user.uid;

  try {
    if (request.method === 'GET') return json(await readAll(env, uid));

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const notes = Array.isArray(body.notes) ? body.notes.slice(0, 5000) : [];
      const notebooks = Array.isArray(body.notebooks) ? body.notebooks.slice(0, 500) : [];
      const stmts = [];

      for (const n of notes) {
        if (!n || typeof n.id !== 'string' || !n.id) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO notes (user_id, id, title, body, notebook_id, tags, trashed, deleted, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(user_id, id) DO UPDATE SET
               title = excluded.title,
               body = excluded.body,
               notebook_id = excluded.notebook_id,
               tags = excluded.tags,
               trashed = excluded.trashed,
               deleted = excluded.deleted,
               updated_at = excluded.updated_at
             WHERE excluded.updated_at > notes.updated_at`
          ).bind(
            uid,
            str(n.id, 80),
            str(n.title, 500),
            typeof n.body === 'string' ? n.body.slice(0, 400000) : '',
            n.notebookId ? str(n.notebookId, 80) : null,
            JSON.stringify(Array.isArray(n.tags) ? n.tags.slice(0, 20).map((t) => str(t, 60)) : []),
            n.trashed ? 1 : 0,
            n.deleted ? 1 : 0,
            Number(n.createdAt) || Date.now(),
            Number(n.updatedAt) || Date.now()
          )
        );
      }

      for (const nb of notebooks) {
        if (!nb || typeof nb.id !== 'string' || !nb.id) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO notebooks (user_id, id, name, color, open, deleted, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(user_id, id) DO UPDATE SET
               name = excluded.name,
               color = excluded.color,
               open = excluded.open,
               deleted = excluded.deleted,
               updated_at = excluded.updated_at
             WHERE excluded.updated_at >= notebooks.updated_at`
          ).bind(
            uid,
            str(nb.id, 80),
            str(nb.name, 120),
            /^#[0-9a-fA-F]{3,8}$/.test(nb.color || '') ? nb.color : '',
            nb.open === false ? 0 : 1,
            nb.deleted ? 1 : 0,
            Number(nb.updatedAt) || 0
          )
        );
      }

      if (stmts.length) await env.DB.batch(stmts);
      return json(await readAll(env, uid));
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
