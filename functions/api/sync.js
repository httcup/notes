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

// 笔记本密码锁：只认 salt/hash/iter/hint 这几个字段，别把乱七八糟的东西存进来
function safeLock(raw) {
  if (!raw) return null;
  let v = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch (e) { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  const salt = str(v.salt, 120), hash = str(v.hash, 200);
  if (!salt || !hash) return null;
  const iter = Math.max(10000, Math.min(600000, Number(v.iter) || 150000));
  return { salt, hash, iter, hint: str(v.hint, 80), at: Number(v.at) || 0 };
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/* 账号级零散状态：现在只有「待办归档」列表。
   archiveAt 是整块状态的版本号（毫秒），谁新用谁的，简单可靠 */
function safePrefs(row) {
  if (!row || !row.json) return null;
  let v;
  try { v = JSON.parse(row.json); } catch (e) { return null; }
  if (!v || typeof v !== 'object') return null;
  const list = Array.isArray(v.todoArchived)
    ? v.todoArchived.slice(0, 2000).map((a) => ({
        k: str(a && a.k, 300),
        noteId: str(a && a.noteId, 80),
        noteTitle: str(a && a.noteTitle, 200),
        text: str(a && a.text, 400),
        due: Number(a && a.due) || 0,
        doneDate: Number(a && a.doneDate) || 0,
        at: Number(a && a.at) || 0
      })).filter((a) => a.k)
    : [];
  return { todoArchived: list, archiveAt: Number(v.archiveAt) || Number(row.updated_at) || 0 };
}

async function readAll(env, uid) {
  const [notesRes, nbsRes, prefsRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM notes WHERE user_id = ?1').bind(uid),
    env.DB.prepare('SELECT * FROM notebooks WHERE user_id = ?1').bind(uid),
    // 账号级零散状态（待办归档等）：老账号还没这行，取不到就是空
    env.DB.prepare('SELECT json, updated_at FROM user_prefs WHERE user_id = ?1').bind(uid)
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
    parentId: r.parent_id || null,     // 二级收纳：指向父笔记本
    order: r.sort_order || 0,
    lock: safeLock(r.lock),            // 笔记本密码锁（salt/hash），没锁就是 null
    updatedAt: r.updated_at || 0
  }));
  return { notes, notebooks, prefs: safePrefs(prefsRes && prefsRes.results && prefsRes.results[0]), serverTime: Date.now() };
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
        // 小程序 / 旧版网页推笔记本时不带 lock 字段：那种情况下必须保留云端已有的锁，
        // 否则一次同步就把密码锁悄悄抹掉了。要拆锁得显式传 lock:null。
        const hasLock = Object.prototype.hasOwnProperty.call(nb, 'lock') ? 1 : 0;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO notebooks (user_id, id, name, color, open, deleted, parent_id, sort_order, updated_at, lock)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(user_id, id) DO UPDATE SET
               name = excluded.name,
               color = excluded.color,
               open = excluded.open,
               deleted = excluded.deleted,
               parent_id = excluded.parent_id,
               sort_order = excluded.sort_order,
               updated_at = excluded.updated_at,
               lock = CASE WHEN ?11 = 1 THEN excluded.lock ELSE notebooks.lock END
             WHERE excluded.updated_at >= notebooks.updated_at`
          ).bind(
            uid,
            str(nb.id, 80),
            str(nb.name, 120),
            /^#[0-9a-fA-F]{3,8}$/.test(nb.color || '') ? nb.color : '',
            nb.open === false ? 0 : 1,
            nb.deleted ? 1 : 0,
            nb.parentId ? str(nb.parentId, 80) : null,
            Number(nb.order) || 0,
            Number(nb.updatedAt) || 0,
            safeLock(nb.lock) ? JSON.stringify(safeLock(nb.lock)) : null,
            hasLock
          )
        );
      }

      // 待办归档列表：整块按 archiveAt 后写覆盖（归档只在本机存过，换设备就空了）
      const prefs = body.prefs;
      const prefsAt = Math.max(0, Number(prefs && prefs.archiveAt) || 0);
      if (prefs && typeof prefs === 'object' && prefsAt > 0) {
        const clean = safePrefs({ json: JSON.stringify(prefs), updated_at: prefsAt });
        if (clean && Array.isArray(clean.todoArchived)) {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO user_prefs (user_id, json, updated_at) VALUES (?1, ?2, ?3)
               ON CONFLICT(user_id) DO UPDATE SET
                 json = excluded.json,
                 updated_at = excluded.updated_at
               WHERE excluded.updated_at > user_prefs.updated_at`
            ).bind(uid, JSON.stringify(clean), prefsAt)
          );
        }
      }

      if (stmts.length) await env.DB.batch(stmts);
      return json(await readAll(env, uid));
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
