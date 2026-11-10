// /api/notesfeed  笔记 → 苹果备忘录（iOS 快捷指令单向推送）
//   GET （带登录）              查询自己是否已开启 / 拿到链接
//   POST {on:true}              开启或取回链接（幂等，token 不变）
//   POST {reset:true}           换一个链接（旧链接立即失效）
//   POST {off:true}             关闭，删除凭证
//   GET ?t=<token>              公开取数（快捷指令只调这一个）：
//                               &nb=笔记本名  只取某个笔记本
//                               &since=毫秒   只取这之后更新过的
//                               &limit=N      最多返回几篇（默认 100，上限 300）
//                               &raw=1        text 直接给 Markdown 原文（默认给渲染后的纯文本）
//   返回里 body=Markdown 原文，text=给备忘录用的正文（默认渲染后纯文本）
import { json, preflight, currentUser, randomHex } from '../_lib.js';

const MAX_NOTES = 300;

/* ---------- Markdown → 渲染后纯文本（给苹果备忘录用） ---------- */
function mdToPlain(src) {
  if (!src) return '';
  let s = String(src).replace(/\r\n?/g, '\n');
  // 围栏代码块：去掉 ``` 行，代码内容原样保留
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (m, code) => '\n' + code.replace(/\n$/, '') + '\n');
  s = s.replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, (m, code) => '\n' + code.replace(/\n$/, '') + '\n');
  const out = [];
  for (const raw of s.split('\n')) {
    let ln = raw;
    // 表格行 → 单元格用制表符隔开；分隔行丢弃
    if (/^\s*\|.*\|\s*$/.test(ln)) {
      const cells = ln.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{3,}:?$/.test(c) || c === '')) continue;
      out.push(cells.join('\t'));
      continue;
    }
    ln = ln
      .replace(/^#{1,6}\s+(.*?)\s*#*$/, '$1')                 // 标题
      .replace(/^\s*>\s?/, '')                                 // 引用
      .replace(/^\s*[-*+]\s+\[ \]\s*/, '□ ')                   // 未完成待办
      .replace(/^\s*[-*+]\s+\[[xX]\]\s*/, '☑ ')                // 已完成待办
      .replace(/^(\s*)[-*+]\s+/, '$1· ');                      // 无序列表
    if (/^\s*([-*_]\s?){3,}$/.test(ln)) { out.push('———'); continue; }  // 水平线
    ln = ln
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, a, u) => a ? `${a}（图：${u}）` : `（图：${u}）`)
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, t, alias) => (alias || t).trim())
      .replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, t, u) => (t && t !== u) ? `${t}（${u}）` : (t || u))
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/==([^=]+)==/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    out.push(ln);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

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
    const raw = /^(1|true|yes)$/i.test(String(url.searchParams.get('raw') || ''));

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
      text: raw ? (r.body || '') : mdToPlain(r.body),
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
