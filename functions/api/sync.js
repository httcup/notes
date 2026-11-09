// Pages Function: /api/sync
// 单用户口令鉴权 + D1 双向同步（按 updatedAt 后写覆盖）

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-ivy-key',
  'access-control-allow-methods': 'GET, POST, OPTIONS'
};

function res(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS
    }
  });
}

function checkKey(request, env) {
  const expected = env.IVY_KEY || '';
  if (!expected) return 'unset';
  const given = request.headers.get('x-ivy-key') || '';
  if (given.length !== expected.length) return 'bad';
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? 'ok' : 'bad';
}

function safeTags(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 20) : [];
  } catch (e) {
    return [];
  }
}

async function readAll(env) {
  const [notesRes, nbsRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM notes'),
    env.DB.prepare('SELECT * FROM notebooks')
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
    open: !!r.open
  }));
  return { notes, notebooks, serverTime: Date.now() };
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const auth = checkKey(request, env);
  if (auth === 'unset') return res({ error: '服务端还没配置 IVY_KEY 口令' }, 503);
  if (auth !== 'ok') return res({ error: '口令不正确' }, 401);
  if (!env.DB) return res({ error: '还没绑定 D1 数据库（变量名 DB）' }, 503);

  try {
    if (request.method === 'GET') return res(await readAll(env));

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const notes = Array.isArray(body.notes) ? body.notes.slice(0, 5000) : [];
      const notebooks = Array.isArray(body.notebooks) ? body.notebooks.slice(0, 500) : [];
      const stmts = [];

      for (const n of notes) {
        if (!n || typeof n.id !== 'string' || !n.id) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO notes (id, title, body, notebook_id, tags, trashed, deleted, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               body = excluded.body,
               notebook_id = excluded.notebook_id,
               tags = excluded.tags,
               trashed = excluded.trashed,
               deleted = excluded.deleted,
               updated_at = excluded.updated_at
             WHERE excluded.updated_at > notes.updated_at`
          ).bind(
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
            `INSERT INTO notebooks (id, name, open, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, open = excluded.open, updated_at = excluded.updated_at
             WHERE excluded.updated_at >= notebooks.updated_at`
          ).bind(str(nb.id, 80), str(nb.name, 120), nb.open === false ? 0 : 1, Date.now())
        );
      }

      if (stmts.length) await env.DB.batch(stmts);
      return res(await readAll(env));
    }

    return res({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return res({ error: String((err && err.message) || err) }, 500);
  }
}
