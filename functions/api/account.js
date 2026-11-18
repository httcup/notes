// /api/account  本人自助注销账号（不需要管理员权限，也不需要联系站主）
//
//   GET   查注销前置信息：账号名、能删多少、为什么不能删
//   POST  { action:'delete', key:'当前口令', confirm:'DELETE' }
//         key     服务端再验一次口令 —— 令牌可能是别人捡到的手机，不能只凭令牌就删号
//         confirm 文本确认口令，挡住误触和脚本顺手调用
//   POST  { action:'verify', key:'当前口令' }
//         只回 ok / 403，不改任何数据。网页端「忘记笔记本密码 → 重置访问锁」用它验明身份。
//
// 删什么：该账号名下全部业务数据（9 张表）+ 上传的图片 + users 表里这一行。
// 主人账号不能在这里注销：它的口令存在环境变量 IVY_KEY 里，数据库里没有可验的行。
//
// 注销成功后，之前发出的令牌会立刻失效（见 _lib.js 的账号存在性校验），
// 否则旧令牌还能继续往已注销的账号里写数据。
import { json, preflight, currentUser, hashPassword, safeEqual, forgetAccount, vipState } from '../_lib.js';
import { countUserData, purgeUserData } from '../_purge.js';

function adminUid(env) {
  return (env && env.ADMIN_UID) || 'owner';
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);

  const user = await currentUser(request, env);
  if (!user) return json({ error: '登录已过期，请重新登录后再操作' }, 401);

  const uid = user.uid;
  const isOwner = uid === adminUid(env);

  try {
    // ── 查：注销页打开时先问一次，把要删的东西摆在用户面前 ──
    if (request.method === 'GET') {
      const vs = await vipState(env, uid);
      return json({
        ok: true,
        name: user.name || '',
        vip: vs.vip,
        vipUntil: vs.until,
        vipOwner: !!vs.owner,
        canDelete: !isOwner,
        reason: isOwner
          ? '主人账号的口令保存在服务端环境变量 IVY_KEY 里，无法在小程序内注销。如需停用请到 Cloudflare 控制台处理。'
          : '',
        counts: await countUserData(env, uid)
      });
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '');

    // ── 验口令：只回答「对不对」，不做任何改动 ──
    // 前端拿它给「忘记笔记本密码 → 重置访问锁」做身份确认。
    // 只用令牌不够：令牌可能是别人捡到的设备，拆锁必须再验一次登录密码。
    if (action === 'verify') {
      const key = String(body.key || '');
      if (key.length < 4) return json({ error: '请输入登录密码' }, 400);
      if (isOwner) {
        // 主人账号的口令在环境变量里，users 表没有可验的行
        if (env.IVY_KEY && safeEqual(key, env.IVY_KEY)) return json({ ok: true, owner: true });
        return json({ error: '登录密码不正确' }, 403);
      }
      const row = await env.DB.prepare('SELECT salt, hash FROM users WHERE id = ?1').bind(uid).first();
      if (!row) return json({ error: '账号不存在或已注销' }, 404);
      const h = await hashPassword(key, row.salt);
      // 同上：用 403 不用 401，否则打错一次密码就被客户端当成登录过期踢出去
      if (!safeEqual(h, row.hash)) return json({ error: '登录密码不正确' }, 403);
      return json({ ok: true });
    }

    if (action !== 'delete') return json({ error: '未知操作' }, 400);

    if (isOwner) return json({ error: '主人账号不能在小程序内注销' }, 400);

    if (String(body.confirm || '').toUpperCase() !== 'DELETE') {
      return json({ error: '确认口令不正确' }, 400);
    }

    const key = String(body.key || '');
    if (key.length < 4) return json({ error: '请输入当前登录口令' }, 400);

    const row = await env.DB.prepare('SELECT id, salt, hash FROM users WHERE id = ?1').bind(uid).first();
    if (!row) return json({ error: '账号不存在或已注销' }, 404);

    // 密码学比较 + 慢哈希，防止拿注销接口当口令爆破入口
    // ⚠️ 这里必须用 403 而不是 401：401 会被客户端当成「登录过期」而清掉登录态，
    //    用户只是打错一次口令就被登出，还得重新登录才能再试 —— 体验和逻辑都不对。
    const h = await hashPassword(key, row.salt);
    if (!safeEqual(h, row.hash)) return json({ error: '口令不正确，未做任何删除' }, 403);

    // 先统计再删，返回给前端做回执（也方便日后排查）
    const counts = await countUserData(env, uid);
    const purged = await purgeUserData(env, uid, { includeAccount: true });
    forgetAccount(uid); // 让本实例立刻拒绝旧令牌

    return json({
      ok: true,
      deleted: true,
      counts,
      media: purged.media,
      warnings: purged.warnings
    });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
