// 账号数据删除清单：自助注销（/api/account）与管理后台清空（/api/admin）共用
//
// 为什么单独抽一份：
//   库里带 user_id 的表有 9 张，注销时漏掉任何一张，用户数据就会残留在库里
//   —— 这是合规上说不清的事。表清单只保留这一份，以后加表只改这里，两边同时生效。
//
// ⚠️ 新增带 user_id 列的表时，务必在 USER_SCOPED_TABLES 里加一行。
export const USER_SCOPED_TABLES = [
  'notes',          // 笔记
  'notebooks',      // 笔记本
  'note_versions',  // 历史版本
  'shares',         // 公开分享快照
  'calendar_feeds', // 待办订阅源
  'ics_sources',    // 苹果日历订阅
  'ics_done',       // 日历勾选状态
  'notes_feeds',    // 笔记推送取数凭证
  'calendar_events', // 苹果日历镜像（Mac 端脚本推上来的事件快照）
  'usage_daily',    // 每日用量计数
  'ai_config'       // 自己填的 AI 接口配置（含加密后的密钥）
];

// 表名来自上面的常量，不接受任何外部输入，拼进 SQL 是安全的
function deleteStmts(env, uid) {
  return USER_SCOPED_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?1`).bind(uid));
}

// 统计「即将删除多少东西」，注销前让用户看清楚自己要失去什么
export async function countUserData(env, uid) {
  const empty = { notes: 0, trashed: 0, notebooks: 0, versions: 0, shares: 0 };
  try {
    const [notesRes, nbsRes, verRes, shareRes] = await env.DB.batch([
      env.DB.prepare(
        `SELECT SUM(CASE WHEN deleted = 0 AND trashed = 0 THEN 1 ELSE 0 END) live,
                SUM(CASE WHEN deleted = 0 AND trashed = 1 THEN 1 ELSE 0 END) trash
           FROM notes WHERE user_id = ?1`
      ).bind(uid),
      env.DB.prepare('SELECT COUNT(*) c FROM notebooks WHERE user_id = ?1 AND deleted = 0').bind(uid),
      env.DB.prepare('SELECT COUNT(*) c FROM note_versions WHERE user_id = ?1').bind(uid),
      env.DB.prepare('SELECT COUNT(*) c FROM shares WHERE user_id = ?1').bind(uid)
    ]);
    const n = (notesRes.results || [])[0] || {};
    const one = (res) => Number(((res.results || [])[0] || {}).c || 0);
    return {
      notes: Number(n.live || 0),
      trashed: Number(n.trash || 0),
      notebooks: one(nbsRes),
      versions: one(verRes),
      shares: one(shareRes)
    };
  } catch (e) {
    return empty; // 统计失败不影响注销本身
  }
}

// 图片存 KV（env.MEDIA）或 R2（env.BUCKET），key 都是 `${uid}/${id}`
async function purgeKv(env, uid, out) {
  if (!env.MEDIA) return;
  const prefix = uid + '/';
  let cursor;
  // 最多 50 轮 × 500 个，够清掉 2.5 万个文件；再多也不会把云函数跑超时
  for (let i = 0; i < 50; i++) {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 500 });
    const keys = (page.keys || []).map((k) => k.name);
    for (const k of keys) await env.MEDIA.delete(k);
    out.media += keys.length;
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
}

async function purgeR2(env, uid, out) {
  if (!env.BUCKET) return;
  const prefix = uid + '/';
  let cursor;
  for (let i = 0; i < 50; i++) {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 500 });
    const keys = (page.objects || []).map((o) => o.key);
    if (keys.length) await env.BUCKET.delete(keys);
    out.media += keys.length;
    if (!page.truncated) break;
    cursor = page.cursor;
  }
}

/**
 * 删除某个账号名下的全部数据
 * @param {object} env  Cloudflare 环境（需要 DB，可选 MEDIA / BUCKET）
 * @param {string} uid  账号 id
 * @param {{includeAccount?: boolean}} opt includeAccount=true 时连 users 里那一行一起删（注销）
 * @returns {Promise<{media:number, warnings:string[]}>}
 */
export async function purgeUserData(env, uid, opt) {
  const includeAccount = !!(opt && opt.includeAccount);

  const stmts = deleteStmts(env, uid);
  if (includeAccount) stmts.push(env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(uid));

  // 数据表放在一个 batch 里（D1 会作为事务执行）：要么全删，要么一条不动，
  // 不会出现「账号没了但笔记还在」这种中间状态
  await env.DB.batch(stmts);

  // 图片不在事务范围内，清理失败也不该让整个注销失败，只如实回报
  const out = { media: 0, warnings: [] };
  for (const fn of [purgeKv, purgeR2]) {
    try {
      await fn(env, uid, out);
    } catch (e) {
      out.warnings.push(String((e && e.message) || e));
    }
  }
  return out;
}
