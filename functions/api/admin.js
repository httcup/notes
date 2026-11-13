// /api/admin  站内管理，只有主人账号能进
//   GET                       账号总览（含主人自己那一片）
//   GET ?uid=<uid>            某账号的笔记清单 / 笔记本 / 分享 / 订阅
//   GET ?uid=<uid>&note=<id>  看单篇正文
//   POST {action:'disable'|'enable'|'purge'|'delete', uid}
//        disable 停用（登录被拒，已发出的令牌最多 30 秒后失效）
//        enable  恢复
//        purge   清空该账号的所有数据，账号本身保留
//        delete  连账号一起删掉
import { json, preflight, currentUser, hashPassword, randomHex } from '../_lib.js';

const OK_UID = /^[A-Za-z0-9_-]{1,80}$/;

function isAdmin(env, user) {
  const adminUid = (env && env.ADMIN_UID) || 'owner';
  return !!user && user.uid === adminUid;
}

const PURGE = [
  'DELETE FROM notes WHERE user_id = ?1',
  'DELETE FROM notebooks WHERE user_id = ?1',
  'DELETE FROM note_versions WHERE user_id = ?1',
  'DELETE FROM shares WHERE user_id = ?1',
  'DELETE FROM ics_sources WHERE user_id = ?1',
  'DELETE FROM ics_done WHERE user_id = ?1',
  'DELETE FROM notes_feeds WHERE user_id = ?1',
  'DELETE FROM calendar_feeds WHERE user_id = ?1',
  'DELETE FROM usage_daily WHERE user_id = ?1'
];

// 读「开放注册」开关（settings 表无记录时视为开放）
async function getRegOpen(env) {
  try {
    const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'reg_open'").first();
    return !row || row.v !== '0';
  } catch { return true; }
}

// D1 数据库总量的估算上限：免费版 5 GB/库，付费版 10 GB/库（可用 DB_QUOTA_GB 覆盖）
function quotaBytes(env) {
  const gb = Number((env && env.DB_QUOTA_GB) || 5);
  return Math.max(1, gb) * 1024 * 1024 * 1024;
}

async function overview(env) {
  const [notesRes, nbsRes, usersRes, feedsRes, srcRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT user_id,
              SUM(CASE WHEN deleted = 0 AND trashed = 0 THEN 1 ELSE 0 END) live,
              SUM(CASE WHEN deleted = 0 AND trashed = 1 THEN 1 ELSE 0 END) trash,
              SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) gone,
              COALESCE(SUM(LENGTH(body)), 0) bytes,
              MAX(updated_at) last_at
         FROM notes GROUP BY user_id`
    ),
    env.DB.prepare('SELECT user_id, COUNT(*) nbs FROM notebooks WHERE deleted = 0 GROUP BY user_id'),
    env.DB.prepare('SELECT id, name, created_at, disabled, disabled_at FROM users ORDER BY created_at'),
    env.DB.prepare('SELECT user_id, COUNT(*) c FROM notes_feeds GROUP BY user_id'),
    env.DB.prepare('SELECT user_id, COUNT(*) c FROM ics_sources GROUP BY user_id')
  ]);

  const by = (res) => {
    const m = new Map();
    for (const r of res.results || []) m.set(r.user_id, r);
    return m;
  };
  const notes = by(notesRes);
  const nbs = by(nbsRes);
  const feeds = by(feedsRes);
  const srcs = by(srcRes);

  const accounts = [];
  const seen = new Set();
  for (const u of usersRes.results || []) {
    seen.add(u.id);
    accounts.push({
      uid: u.id,
      name: u.name || u.id,
      createdAt: u.created_at || 0,
      disabled: !!u.disabled,
      disabledAt: u.disabled_at || 0,
      self: u.id === ((env && env.ADMIN_UID) || 'owner')
    });
  }
  // 主人账号不在 users 表里（口令走环境变量），单独补一行
  if (!seen.has('owner')) {
    accounts.unshift({ uid: 'owner', name: '主人', createdAt: 0, disabled: false, disabledAt: 0, self: true });
  }
  for (const a of accounts) {
    const n = notes.get(a.uid) || {};
    a.live = n.live || 0;
    a.trash = n.trash || 0;
    a.gone = n.gone || 0;
    a.bytes = n.bytes || 0;
    a.lastAt = n.last_at || 0;
    a.notebooks = (nbs.get(a.uid) || {}).nbs || 0;
    a.feed = ((feeds.get(a.uid) || {}).c || 0) > 0;
    a.icsSources = (srcs.get(a.uid) || {}).c || 0;
  }
  accounts.sort((x, y) => (y.lastAt || y.createdAt) - (x.lastAt || x.createdAt));
  const used = accounts.reduce((s, a) => s + a.bytes, 0);
  const quota = quotaBytes(env);
  return {
    ok: true,
    regOpen: await getRegOpen(env),
    accounts,
    totals: {
      accounts: accounts.length,
      notes: accounts.reduce((s, a) => s + a.live + a.trash, 0),
      bytes: used,
      quota,
      free: Math.max(0, quota - used)
    }
  };
}

async function detail(env, uid) {
  const [notesRes, nbsRes, shareRes, feedRes, srcRes, verRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, title, trashed, deleted, LENGTH(body) bytes, created_at, updated_at
         FROM notes WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 500`
    ).bind(uid),
    env.DB.prepare(
      'SELECT id, name, color, deleted, updated_at FROM notebooks WHERE user_id = ?1 ORDER BY updated_at DESC'
    ).bind(uid),
    env.DB.prepare('SELECT COUNT(*) c FROM shares WHERE user_id = ?1').bind(uid),
    env.DB.prepare('SELECT COUNT(*) c FROM notes_feeds WHERE user_id = ?1').bind(uid),
    env.DB.prepare('SELECT COUNT(*) c FROM ics_sources WHERE user_id = ?1').bind(uid),
    env.DB.prepare('SELECT COUNT(*) c FROM note_versions WHERE user_id = ?1').bind(uid)
  ]);
  return {
    ok: true,
    uid,
    notes: (notesRes.results || []).map((r) => ({
      id: r.id,
      title: r.title || '',
      trashed: !!r.trashed,
      deleted: !!r.deleted,
      bytes: r.bytes || 0,
      createdAt: r.created_at || 0,
      updatedAt: r.updated_at || 0
    })),
    notebooks: (nbsRes.results || []).map((r) => ({
      id: r.id,
      name: r.name || '',
      color: r.color || '',
      deleted: !!r.deleted,
      updatedAt: r.updated_at || 0
    })),
    shares: (shareRes.results?.[0] || {}).c || 0,
    feed: ((feedRes.results?.[0] || {}).c || 0) > 0,
    icsSources: (srcRes.results?.[0] || {}).c || 0,
    versions: (verRes.results?.[0] || {}).c || 0
  };
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);

  const user = await currentUser(request, env);
  if (!user) return json({ error: '请先用主人口令登录' }, 401);
  if (!isAdmin(env, user)) return json({ error: '没有管理权限' }, 403);

  const url = new URL(request.url);
  const uid = String(url.searchParams.get('uid') || '').trim();

  try {
    if (request.method === 'GET') {
      if (!uid) return json(await overview(env));
      if (!OK_UID.test(uid)) return json({ error: 'uid 不合法' }, 400);

      const noteId = String(url.searchParams.get('note') || '').trim();
      if (noteId) {
        const row = await env.DB.prepare(
          'SELECT id, title, body, updated_at FROM notes WHERE user_id = ?1 AND id = ?2'
        ).bind(uid, noteId).first();
        if (!row) return json({ error: '这篇笔记不存在' }, 404);
        return json({
          ok: true,
          note: { id: row.id, title: row.title || '', body: row.body || '', updatedAt: row.updated_at || 0 }
        });
      }
      return json(await detail(env, uid));
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const action = String(body.action || '');

      // 站点开关类操作，不需要 uid
      if (action === 'setReg') {
        const open = body.regOpen !== false;
        await env.DB.prepare(
          "INSERT INTO settings (k, v, updated_at) VALUES ('reg_open', ?1, ?2) " +
          'ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at'
        ).bind(open ? '1' : '0', Date.now()).run();
        return json({ ok: true, regOpen: open });
      }

      // 手动开号：替别人注册账号，不受「开放注册」开关限制
      if (action === 'createUser') {
        const name = String(body.name || '').trim();
        const key = String(body.key || '');
        if (!/^[\w\u4e00-\u9fa5.-]{2,24}$/.test(name)) {
          return json({ error: '账号 2-24 位，可用中英文、数字、_ . -' }, 400);
        }
        if (key.length < 4) return json({ error: '口令至少 4 位' }, 400);
        const dup = await env.DB.prepare('SELECT id FROM users WHERE name = ?1').bind(name).first();
        if (dup) return json({ error: '该用户名已被占用' }, 400);
        const id = 'u' + randomHex(8);
        const salt = randomHex(16);
        const hash = await hashPassword(key, salt);
        await env.DB.prepare(
          'INSERT INTO users (id, name, salt, hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)'
        ).bind(id, name, salt, hash, Date.now()).run();
        return json({ ok: true, uid: id, name });
      }

      const target = String(body.uid || '').trim();
      if (!OK_UID.test(target)) return json({ error: 'uid 不合法' }, 400);
      if (target === ((env && env.ADMIN_UID) || 'owner')) {
        return json({ error: '不能对自己（主人账号）做这个操作' }, 400);
      }

      const exists = await env.DB.prepare('SELECT id, name, disabled FROM users WHERE id = ?1').bind(target).first();
      // 主人账号不在 users 表里，其余账号必须存在（清空孤儿数据除外）
      if (!exists && action !== 'purge') return json({ error: '账号不存在' }, 404);

      if (action === 'disable') {
        await env.DB.prepare('UPDATE users SET disabled = 1, disabled_at = ?2 WHERE id = ?1')
          .bind(target, Date.now()).run();
        return json({ ok: true, uid: target, disabled: true });
      }
      if (action === 'enable') {
        await env.DB.prepare('UPDATE users SET disabled = 0, disabled_at = 0 WHERE id = ?1').bind(target).run();
        return json({ ok: true, uid: target, disabled: false });
      }
      // 后台重置某个账号的密码（对方之前发出的令牌仍然有效，下次登录要用新密码）
      if (action === 'setPass') {
        const key = String(body.key || '');
        if (key.length < 4) return json({ error: '新密码至少 4 位' }, 400);
        if (!exists) return json({ error: '账号不存在' }, 404);
        const salt = randomHex(16);
        const hash = await hashPassword(key, salt);
        await env.DB.prepare('UPDATE users SET salt = ?2, hash = ?3 WHERE id = ?1')
          .bind(target, salt, hash).run();
        return json({ ok: true, uid: target, name: exists.name || '' });
      }
      if (action === 'purge' || action === 'delete') {
        const stmts = PURGE.map((sql) => env.DB.prepare(sql).bind(target));
        if (action === 'delete') stmts.push(env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(target));
        await env.DB.batch(stmts);
        return json({ ok: true, uid: target, purged: true, deleted: action === 'delete' });
      }
      return json({ error: '未知操作' }, 400);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
