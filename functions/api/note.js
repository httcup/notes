// /api/note —— 现成 Markdown → 笔记本
//
// /api/pdf 负责「PDF 转 Markdown」，这个端点负责「已经转好的 Markdown 直接入库」。
// 典型用途：把长图 / 截图 / 聊天里整理好的文字交给 WorkBuddy 转成 Markdown，
// 再由这里一键写进 n.139t.cn；也可以给快捷指令、脚本或任何 webhook 用。
//
// POST /api/note  body { markdown, title, notebook, source, id }
//   markdown（别名 md / text / content / body）必填；id 给了就用它，否则按内容哈希幂等。
//   鉴权与 /api/pdf 相同：x-pdf-key / x-capture-key / ?k= / 登录态。
//   JSON、表单、纯文本都认；?format=html 返回排版预览页。

import { currentUser, safeEqual, CORS } from '../_lib.js';

const CORS_OPEN = {
  ...CORS,
  'access-control-allow-headers': 'content-type, x-ivy-key, authorization, x-capture-key, x-pdf-key'
};

const MAX_MD = 400000;
const DEFAULT_NOTEBOOK = '导入';

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_OPEN }
  });
}
const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function stamp(ts) {
  return new Date(ts + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) + '（北京时间）';
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function identity(request, url, env) {
  const key = request.headers.get('x-pdf-key') || request.headers.get('x-capture-key')
    || url.searchParams.get('k') || '';
  const ok = [env.PDF_IMPORT_KEY, env.CAPTURE_KEY].some((s) => s && key && safeEqual(key, s));
  if (ok) return { uid: env.PDF_UID || env.CAPTURE_UID || 'owner' };
  const user = await currentUser(request, env);
  return user ? { uid: user.uid } : null;
}

async function parseIncoming(request, url) {
  const q = url.searchParams;
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  let obj = {}, raw = '';
  if (request.method === 'POST') {
    if (/multipart\/form-data/i.test(ct)) {
      const fd = await request.formData().catch(() => null);
      if (fd) for (const [k, v] of fd) if (typeof v === 'string') obj[k] = v;
    } else {
      raw = (await request.text().catch(() => '')).slice(0, MAX_MD * 2);
      const t = raw.trim();
      if (/json/i.test(ct) || t.startsWith('{') || t.startsWith('[')) {
        try { obj = JSON.parse(t); } catch (e) { obj = {}; }
      } else if (/x-www-form-urlencoded/i.test(ct)) {
        obj = Object.fromEntries(new URLSearchParams(t));
      }
    }
  }
  const pick = (keys) => {
    for (const k of keys) {
      const a = str(q.get(k), MAX_MD).trim(); if (a) return a;
      const b = str(obj && obj[k], MAX_MD).trim(); if (b) return b;
    }
    return '';
  };
  const md = pick(['markdown', 'md', 'text', 'content', 'body']) ||
    ((!obj || !Object.keys(obj).length) && raw.trim() ? raw.trim() : '');
  return {
    markdown: md,
    title: pick(['title', 'subject', 'name']),
    notebook: pick(['notebook', 'folder', '笔记本']),
    source: pick(['source', 'from', 'channel']),
    id: pick(['id', 'noteId', 'note_id'])
  };
}

/** 极简 Markdown → HTML，只用于 ?format=html 预览 */
function previewHtml(title, md) {
  const escInline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, a, u) => `<a href="${/^https?:\/\//i.test(u) ? u : '#'}">${a}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let para = [], code = null;
  const flush = () => { if (para.length) { out.push('<p>' + escInline(para.join(' ')) + '</p>'); para = []; } };
  for (const raw of String(md || '').split('\n')) {
    if (/^```/.test(raw.trim())) {
      if (code === null) { flush(); code = []; }
      else { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; }
      continue;
    }
    if (code !== null) { code.push(raw); continue; }
    if (!raw.trim()) { flush(); continue; }
    const h = /^(#{1,6})\s+(.+)$/.exec(raw);
    if (h) { flush(); const n = Math.min(6, h[1].length); out.push(`<h${n}>` + escInline(h[2]) + `</h${n}>`); continue; }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (li) { flush(); out.push('<li>' + escInline(li[1]) + '</li>'); continue; }
    if (/^>\s?/.test(raw)) { flush(); out.push('<blockquote>' + escInline(raw.replace(/^>\s?/, '')) + '</blockquote>'); continue; }
    para.push(raw.trim());
  }
  if (code !== null) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  flush();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;padding:32px 20px;background:#f7f8f9;color:#1c1f22;font:16px/1.85 -apple-system,"PingFang SC",sans-serif}
main{max-width:780px;margin:0 auto;background:#fff;padding:40px 44px;border:1px solid #e8ebee;border-radius:14px}
h1{font:600 26px Georgia,"Songti SC",serif;margin:0 0 26px}h2,h3{margin:1.6em 0 .6em}blockquote{border-left:3px solid #3f7a5b;background:#f4f8f5;padding:8px 16px;margin:1em 0}
code{background:#f2f4f6;padding:2px 5px;border-radius:4px}pre{background:#1e252d;color:#e7edf3;padding:16px;border-radius:9px;overflow:auto}
pre code{background:none;color:inherit}li{margin:.3em 0}a{color:#287a52}</style></head><body><main><h1>${esc(title)}</h1>${out.join('\n')}</main></body></html>`;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_OPEN });
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB) return reply({ error: '还没绑定 D1 数据库（变量名 DB）' }, 503);

  const url = new URL(request.url);
  const me = await identity(request, url, env);
  if (!me) return reply({ error: '缺少密钥：请用 x-pdf-key，或先在笔记站登录' }, 401);

  const inc = await parseIncoming(request, url);
  const md = str(inc.markdown, MAX_MD).trim();
  if (!md) return reply({ error: 'markdown 不能为空' }, 400);

  const now = Date.now();
  const autoTitle = md.split('\n').map((l) => l.trim())
    .find((l) => /^#{1,6}\s+/.test(l) || l.length >= 4);
  const title = (str(inc.title, 300).trim()
    || (autoTitle || '').replace(/^#{1,6}\s+/, '').replace(/[*_`\[\]]/g, '').trim()
    || '导入 ' + stamp(now)).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const notebook = str(inc.notebook, 60).trim() || DEFAULT_NOTEBOOK;
  const source = str(inc.source, 24).trim().replace(/[\r\n<>]/g, ' ') || 'Webhook';
  const hash = await sha256(md);
  const id = (str(inc.id, 80).trim() || 'note_' + hash.slice(0, 16)).replace(/[^A-Za-z0-9_-]/g, '_');
  const nbId = 'nb_import_' + me.uid;
  const tags = JSON.stringify(['导入', source]);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO notebooks (user_id, id, name, color, open, deleted, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, 0, ?5)
         ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, deleted = 0, updated_at = excluded.updated_at`
      ).bind(me.uid, nbId, notebook, '#3f7a5b', now),
      env.DB.prepare(
        `INSERT INTO notes (user_id, id, title, body, notebook_id, tags, trashed, deleted, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, ?7)
         ON CONFLICT(user_id, id) DO UPDATE SET
           title = excluded.title, body = excluded.body, notebook_id = excluded.notebook_id,
           tags = excluded.tags, trashed = 0, deleted = 0, updated_at = excluded.updated_at`
      ).bind(me.uid, id, title, md, nbId, tags, now)
    ]);
  } catch (err) {
    return reply({ error: String((err && err.message) || err) }, 500);
  }

  const out = {
    ok: true, noteId: id, title, notebook, chars: md.length,
    noteUrl: `${url.origin}/?n=${id}`
  };
  if (url.searchParams.get('format') === 'html') {
    return new Response(previewHtml(title, md), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...CORS_OPEN }
    });
  }
  return reply(out);
}
