// POST /api/auth  登录 / 注册 / 改密码，换一个 90 天有效的令牌
import { json, preflight, hashPassword, randomHex, signToken, safeEqual, currentUser } from '../_lib.js';

const TTL = 90 * 864e5;
// 注册开关关闭时给新用户的提示（站主可在管理后台开/关）
const REG_CLOSED_MSG = '同步功能暂时关闭，可使用保存本地的功能，如需同步功能请联系管理员：201965';

// 读「开放注册」开关：settings 表没有记录时视为开放
async function regOpen(env) {
  try {
    const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'reg_open'").first();
    return !row || row.v !== '0';
  } catch { return true; }
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);
  // GET：给前端查「是否开放注册」，用来置灰注册按钮
  if (request.method === 'GET') return json({ ok: true, regOpen: await regOpen(env) });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const key = String(body.key || '');
  if (key.length < 4) return json({ error: '口令至少 4 位' }, 400);

  // 改自己的密码：要带登录令牌（证明是本人设备），并且再验一次旧密码
  if (body.action === 'passwd') {
    if (!env.IVY_SECRET) return json({ error: '服务端未配置 IVY_SECRET' }, 503);
    const newKey = String(body.newKey || '');
    if (newKey.length < 4) return json({ error: '新密码至少 4 位' }, 400);
    if (safeEqual(newKey, key)) return json({ error: '新密码和当前密码一样' }, 400);
    const me = await currentUser(request, env);
    if (!me) return json({ error: '登录已过期，请重新登录后再改' }, 401);
    if (me.uid === ((env && env.ADMIN_UID) || 'owner')) {
      return json({ error: '主人账号的口令在环境变量 IVY_KEY 里，请到 Cloudflare 控制台修改' }, 400);
    }
    const row = await env.DB.prepare('SELECT id, salt, hash FROM users WHERE id = ?1').bind(me.uid).first();
    if (!row) return json({ error: '账号不存在' }, 404);
    const h = await hashPassword(key, row.salt);
    if (!safeEqual(h, row.hash)) return json({ error: '当前密码不正确' }, 401);
    const salt = randomHex(16);
    const hash = await hashPassword(newKey, salt);
    await env.DB.prepare('UPDATE users SET salt = ?2, hash = ?3 WHERE id = ?1').bind(row.id, salt, hash).run();
    return json({ ok: true });
  }

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

  const open = await regOpen(env);

  if (row) {
    const h = await hashPassword(key, row.salt);
    if (!safeEqual(h, row.hash)) return json({ error: '口令不正确' }, 401);
    if (row.disabled) return json({ error: '该账号已被停用，请联系站主' }, 403);
    const token = await signToken({ u: row.id, n: row.name, e: Date.now() + TTL }, env.IVY_SECRET);
    return json({ token, name: row.name, uid: row.id });
  }

  // 账号不存在：注册关了就不再引导去注册，直接说明情况
  if (!body.create) {
    if (!open) return json({ error: REG_CLOSED_MSG }, 403);
    return json({ error: '账号不存在，可以点「注册」新建' }, 404);
  }
  if (!open) return json({ error: REG_CLOSED_MSG }, 403);

  const id = 'u' + randomHex(8);
  const salt = randomHex(16);
  const hash = await hashPassword(key, salt);
  await env.DB.prepare('INSERT INTO users (id, name, salt, hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, name, salt, hash, Date.now())
    .run();
  const token = await signToken({ u: id, n: name, e: Date.now() + TTL }, env.IVY_SECRET);
  return json({ token, name, uid: id, created: true });
}
