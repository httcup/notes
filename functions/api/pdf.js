// /api/pdf —— PDF / 长图 → Markdown → 笔记本（同一个 iOS 快捷指令入口）
//
// 和 /api/capture（剪藏网页）并列，是第二条「往里写」的通道：
//   手机里把 PDF 或长图分享给**同一条快捷指令** → POST 到这里 → Workers AI
//   （PDF 走文本抽取，图片走视觉模型 caption + OCR）转成结构化 Markdown →
//   写进 D1 的同一个「PDF 导入」笔记本 → 笔记站 45 秒轮询或重开页面就能看到。
//   原始文件也存一份进媒体库，笔记末尾附链接，转不出文字时还能看原件。
//   PDF 与图片只是 noteId 前缀（pdf_ / img_）和标签不同，笔记本不分开。
//
// 鉴权：请求头 x-capture-key: <CAPTURE_KEY>，或 ?k=<KEY>，或已登录态（Bearer / x-ivy-key）。
// 不需要改前端 public/index.html，不需要改数据库结构。
//
// POST /api/pdf  四种输入都认：
//   1. multipart/form-data   字段 file（PDF），可选 title / notebook / source
//   2. application/pdf       请求体就是 PDF 二进制
//   3. application/json      { pdf: "<base64 或 data URL>", filename, title, notebook }
//   4. 表单 / JSON / query   url=<PDF 地址>，服务端下载（也可以 ?url= 直接 GET）
//   ?format=json|md|html    默认 json；md 返回纯 Markdown；html 返回排版好的预览页
//   ?keep=0                 不存原始 PDF（默认存）
// GET  /api/pdf?k=<KEY>     手机浏览器里选 PDF 上传的极简表单
// GET  /api/pdf?k=<KEY>&url=<PDF 地址>   只能发 GET 的 webhook
//
// 幂等：noteId 由 PDF 字节的 SHA-256 生成，重复推送只更新同一篇，不会产生重复笔记。
// 降级：AI 绑定缺失或转换失败时，不写脏正文，只建一条带原件链接的笔记。

import { currentUser, safeEqual, CORS } from '../_lib.js';

const CORS_OPEN = {
  ...CORS,
  'access-control-allow-headers': 'content-type, x-ivy-key, authorization, x-capture-key'
};

const MAX_PDF = 20 * 1024 * 1024;   // 和 /api/media 一致
const MAX_MD = 400000;              // 和 /api/sync 的 body 上限一致
const DEFAULT_NOTEBOOK = 'PDF 导入';

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_OPEN }
  });
}

function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

function stamp(ts) {
  return new Date(ts + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) + '（北京时间）';
}

function humanSize(n) {
  return n < 1024 ? n + ' B'
    : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB'
      : (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 只留 http(s)，挡内网 / 云元数据地址，避免这个「能写库的端点」被拿去探内网 */
function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|metadata)/.test(h)) return null;
  return u;
}

async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64ToBuffer(s) {
  try {
    let v = String(s || '').replace(/^data:[^,]*,/i, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    v += '='.repeat((4 - (v.length % 4)) % 4);
    const bin = atob(v);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  } catch (e) { return new ArrayBuffer(0); }   // 不是合法 base64 就当没给文件
}

/** 认 PDF 和图片（PNG / JPEG / WebP / SVG），返回类型与 MIME；HEIC 单独提示 */
function detectFile(buf) {
  const h = new Uint8Array(buf.slice(0, 32));
  const ascii = (a, b) => String.fromCharCode(...h.slice(a, b));
  const head = new Uint8Array(buf.slice(0, 1024));
  if (String.fromCharCode(...head).includes('%PDF-')) return { kind: 'pdf', mime: 'application/pdf' };
  if (h[0] === 0x89 && ascii(1, 4) === 'PNG') return { kind: 'image', mime: 'image/png' };
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  const text = new TextDecoder().decode(new Uint8Array(buf.slice(0, 512))).trim();
  if (/^<svg[\s>]/i.test(text) || /^<\?xml[\s\S]*?<svg[\s>]/i.test(text)) return { kind: 'image', mime: 'image/svg+xml' };
  if (/ftyp(heic|heix|mif1|msf1)/i.test(ascii(4, 20))) return { kind: 'heic', mime: 'image/heic' };
  return null;
}

function cleanLabel(s) {
  return String(s || '').replace(/[\r\n\t<>`*\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
}

// ---- 输入归一化：快捷指令、n8n、IFTTT、curl 发什么格式都能接 -----------------
async function parseIncoming(request, url) {
  const q = url.searchParams;
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  const fields = {};
  let bytes = null, filename = '', format = 'query';

  if (request.method === 'POST') {
    if (/multipart\/form-data/i.test(ct)) {
      const fd = await request.formData().catch(() => null);
      if (fd) {
        for (const [k, v] of fd) {
          if (typeof v === 'string') fields[k] = v;
          else if (!bytes && v && typeof v.arrayBuffer === 'function') {
            bytes = await v.arrayBuffer();
            filename = v.name || '';
          }
        }
      }
      format = 'multipart';
    } else if (/application\/pdf|application\/octet-stream|^image\//i.test(ct)) {
      bytes = await request.arrayBuffer().catch(() => null);
      format = 'binary';
    } else {
      const raw = (await request.text().catch(() => '')).slice(0, MAX_PDF * 2);
      const t = raw.trim();
      if (/json/i.test(ct) || t.startsWith('{') || t.startsWith('[')) {
        let obj = null;
        try { obj = JSON.parse(t); } catch (e) { /* 不是 JSON 就当文本 */ }
        format = 'json';
        if (obj && typeof obj === 'object') {
          const inner = obj.data || obj.payload || obj.event || obj;
          for (const [k, v] of Object.entries(inner)) if (typeof v === 'string') fields[k] = v;
          const b64 = fields.pdf || fields.file || fields.image || fields.img || fields.photo || fields.base64 || fields.content || fields.pdf_base64 || fields.data || '';
          if (/^[A-Za-z0-9+/=_-]{64,}$/.test(b64) || /^data:/i.test(b64)) bytes = b64ToBuffer(b64);
        } else if (typeof obj === 'string' && obj.length > 64) {
          bytes = b64ToBuffer(obj);
        }
      } else if (/x-www-form-urlencoded/i.test(ct) || /^[\w.-]+=[^\s]*$/.test(t)) {
        for (const [k, v] of new URLSearchParams(t)) fields[k] = v;
        format = 'form';
        const b64 = fields.pdf || fields.file || fields.image || fields.img || fields.base64 || '';
        if (/^[A-Za-z0-9+/=_-]{64,}$/.test(b64) || /^data:/i.test(b64)) bytes = b64ToBuffer(b64);
      }
      if (bytes) format += '+base64';
    }
  }

  const get = (keys) => {
    for (const k of keys) {
      const a = str(q.get(k), 2000).trim(); if (a) return a;
      const b = str(fields[k], 2000).trim(); if (b) return b;
    }
    return '';
  };

  const pdfUrl = get(['url', 'link', 'href', 'pdf_url', 'file_url']);
  const title = get(['title', 'subject', 'name']);
  const notebook = get(['notebook', 'folder', '笔记本']);
  const source = get(['source', 'from', 'channel', 'provider']);
  filename = str(filename || get(['filename', 'fileName', 'file_name']), 200).trim();

  if (!bytes && pdfUrl) {
    const u = safeUrl(pdfUrl);
    if (!u) return { error: '这个地址不能抓取', format };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(u.toString(), {
        headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1', 'accept': 'application/pdf,*/*' },
        signal: ctl.signal, redirect: 'follow'
      });
      if (!res.ok) return { error: '下载文件失败：HTTP ' + res.status, format };
      bytes = await res.arrayBuffer();
      if (!filename) {
        const last = u.pathname.split('/').pop() || '';
        if (/\.(pdf|png|jpe?g|webp|svg)$/i.test(last)) filename = decodeURIComponent(last);
      }
    } catch (e) {
      return { error: '下载文件失败：' + String((e && e.message) || e).slice(0, 100), format };
    } finally { clearTimeout(timer); }
    format = format === 'query' ? 'url' : format + '+url';
  }

  return { bytes, filename, title, notebook, source, pdfUrl, format };
}

// ---- Workers AI：PDF / 图片 → 结构化 Markdown ---------------------------------
async function toMarkdown(env, bytes, filename, mime, kind) {
  if (!env.AI || typeof env.AI.toMarkdown !== 'function') {
    return { md: '', error: '服务端没有绑定 Workers AI（变量名 AI）' };
  }
  const doc = { name: filename || 'import.pdf', blob: new Blob([bytes], { type: mime || 'application/pdf' }) };
  // PDF 关掉元数据；图片走视觉模型（caption + OCR），不传 pdf 选项
  const opts = kind === 'pdf' ? { conversionOptions: { pdf: { metadata: false } } } : undefined;
  let out;
  try {
    out = await env.AI.toMarkdown(doc, opts);
  } catch (e) {
    // 兼容不接受 conversionOptions 的旧运行时
    try { out = await env.AI.toMarkdown(doc); }
    catch (e2) { return { md: '', error: String((e2 && e2.message) || e2).slice(0, 200) }; }
  }
  const r = Array.isArray(out) ? out[0] : out;
  if (!r || r.format === 'error' || typeof r.data !== 'string') {
    return { md: '', error: String((r && r.error) || '转换没有返回内容').slice(0, 200) };
  }
  const md = r.data.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, MAX_MD);
  return { md, tokens: Number(r.tokens) || 0, error: md ? '' : '没提取到文字（可能是纯扫描件或压缩过度的长图）' };
}

/** Markdown 第一个像话的标题，用来当笔记标题 */
function firstHeading(md) {
  for (const line of String(md || '').split('\n').slice(0, 60)) {
    const h = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (h) return h[1].replace(/[*_`\[\]]/g, '').trim().slice(0, 200);
    if (line.trim().length >= 4 && !/^[-*>|\s]/.test(line) && !/^https?:/.test(line.trim())) {
      return line.trim().replace(/[*_`\[\]]/g, '').slice(0, 200);
    }
  }
  return '';
}

// ---- 可选：Markdown → 排版好的 HTML 预览页（不写进笔记） ---------------------
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeHref(u) {
  // 传进来的整行已经过 esc()，这里只做协议白名单，别再转义一次
  const s = String(u || '').trim();
  return /^(https?:\/\/|\/|data:image\/)/i.test(s) ? s : '#';
}

function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, a, u) => `<img src="${safeHref(u)}" alt="${a}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, a, u) => `<a href="${safeHref(u)}" target="_blank" rel="noopener">${a}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

function mdToHtml(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let list = '', para = [], code = null, quote = [];

  const flushPara = () => { if (para.length) { out.push('<p>' + inlineMd(para.join(' ')) + '</p>'); para = []; } };
  const flushQuote = () => { if (quote.length) { out.push('<blockquote>' + inlineMd(quote.join(' ')) + '</blockquote>'); quote = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = ''; } };
  const flush = () => { flushPara(); flushQuote(); flushList(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line.trim())) {
      if (code === null) { flush(); code = []; }
      else { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; }
      continue;
    }
    if (code !== null) { code.push(raw); continue; }
    if (!line.trim()) { flush(); continue; }
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) { flush(); out.push('<hr>'); continue; }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) { flush(); const n = Math.min(6, h[1].length + 1); out.push(`<h${n}>` + inlineMd(h[2]) + `</h${n}>`); continue; }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (li) {
      flushPara(); flushQuote();
      const want = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list !== want) { flushList(); list = want; out.push(`<${list}>`); }
      out.push('<li>' + inlineMd(li[1]) + '</li>');
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
      flushPara(); flushQuote(); flushList();
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inlineMd(c.trim()));
      const row = '<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>';
      const last = out[out.length - 1] || '';
      if (/<\/table>$/.test(last)) out[out.length - 1] = last.replace(/<\/table>$/, row + '</table>');
      else out.push('<table>' + row + '</table>');
      continue;
    }
    flushQuote(); flushList();
    para.push(line.trim());
  }
  if (code !== null) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  flush();
  return out.join('\n');
}

function htmlPage(title, md, meta) {
  const body = mdToHtml(md);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}
body{margin:0;padding:32px 20px 80px;background:#f7f8f9;color:#1c1f22;font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:780px;margin:0 auto;background:#fff;padding:40px 44px;border:1px solid #e8ebee;border-radius:14px;box-shadow:0 2px 14px rgba(20,30,40,.04)}
.meta{font-size:13px;color:#868d94;border-bottom:1px solid #edf0f2;padding-bottom:16px;margin-bottom:28px}
h1{font:600 26px/1.4 Georgia,"Songti SC",serif;margin:0 0 26px}
h2,h3,h4,h5,h6{line-height:1.45;margin:1.7em 0 .7em;font-weight:600}
h2{font-size:21px;border-bottom:1px solid #eef1f3;padding-bottom:8px}
p{margin:0 0 1em}ul,ol{padding-left:1.5em}li{margin:.3em 0}
blockquote{margin:1.2em 0;padding:8px 16px;border-left:3px solid #3f7a5b;background:#f4f8f5;color:#4c5650}
blockquote p{margin:0}code{background:#f2f4f6;padding:2px 5px;border-radius:4px;font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:#1e252d;color:#e7edf3;padding:16px 18px;border-radius:9px;overflow:auto}
pre code{background:none;color:inherit;padding:0}
img{max-width:100%;height:auto;border-radius:6px}a{color:#287a52;text-decoration:none}a:hover{text-decoration:underline}
table{border-collapse:collapse;width:100%;margin:1em 0}td{border:1px solid #e3e8eb;padding:8px 11px}
hr{border:0;border-top:1px solid #e8ebee;margin:2em 0}
@media(max-width:640px){body{padding:14px 10px 50px}main{padding:24px 20px}h1{font-size:22px}}
@media print{body{background:#fff;padding:0}main{border:0;box-shadow:none;padding:0}}
</style></head><body><main>
<div class="meta">${esc(meta)}</div><h1>${esc(title)}</h1>
${body || '<p style="color:#868d94">（没有提取到正文，请用笔记里的原始 PDF 链接查看）</p>'}
</main></body></html>`;
}

// ---- 手机浏览器里选 PDF 上传的表单 -----------------------------------------
function formPage() {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>PDF / 长图 存进笔记本</title>
<style>body{margin:0;padding:24px;background:#f7f8f9;color:#1c1f22;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
.wrap{max-width:520px;margin:0 auto}h1{font:500 19px/1.4 Georgia,"Songti SC",serif;margin:0 0 4px}
p{color:#70767c;font-size:13px;margin:0 0 18px}label{display:block;font-size:13px;color:#464b50;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #e6e9ec;border-radius:10px;background:#fff;font:inherit;outline:none}
input:focus{border-color:#287a52}button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:10px;background:#287a52;color:#fff;font:500 15px inherit}
button:disabled{opacity:.55}#msg{margin-top:14px;font-size:13px;color:#1b5c3c;min-height:20px;word-break:break-all}</style></head>
<body><div class="wrap"><h1>PDF / 长图 存进笔记本</h1>
<p>选一个 PDF 或长图（截图），会自动转成 Markdown 存进同一个笔记本，原件也一起留着。</p>
<form id="f"><label for="p">PDF 或长图（≤20MB）</label><input id="p" type="file" accept="application/pdf,.pdf,image/png,image/jpeg,image/webp,image/svg+xml" required>
<label for="t">标题（选填，默认用文件名）</label><input id="t" placeholder="留空自动取文件名或正文标题">
<button id="b" type="submit">转换并保存</button></form><div id="msg"></div></div>
<script>
const key = new URLSearchParams(location.search).get('k') || '';
history.replaceState(null, '', location.pathname);
const f = document.getElementById('f'), b = document.getElementById('b'), msg = document.getElementById('msg');
f.onsubmit = async (e) => {
  e.preventDefault(); b.disabled = true; b.textContent = '正在转换…'; msg.textContent = '';
  const fd = new FormData();
  fd.append('file', document.getElementById('p').files[0]);
  const t = document.getElementById('t').value.trim(); if (t) fd.append('title', t);
  try {
    const r = await fetch(location.pathname, { method:'POST', headers:{ 'x-capture-key':key }, body:fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    msg.innerHTML = '已存进「' + d.notebook + '」：' + d.title +
      (d.mode === 'original' ? '（没提取到文字，只存了原件）' : '（' + d.chars + ' 字）') +
      '<br><a href="' + d.noteUrl + '" target="_blank" style="color:#287a52">打开笔记 →</a>';
    f.reset();
  } catch (err) { msg.textContent = '没成功：' + err.message; }
  finally { b.disabled = false; b.textContent = '转换并保存'; }
};
</script></body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...CORS_OPEN }
  });
}

async function identity(request, url, env) {
  // PDF 导入用独立的 PDF_IMPORT_KEY（不影响昨晚配好的剪藏快捷指令），也兼容旧的 CAPTURE_KEY
  const key = request.headers.get('x-pdf-key') || request.headers.get('x-capture-key')
    || url.searchParams.get('k') || '';
  const ok = [env.PDF_IMPORT_KEY, env.CAPTURE_KEY].some((s) => s && key && safeEqual(key, s));
  if (ok) return { uid: env.PDF_UID || env.CAPTURE_UID || 'owner', via: 'key' };
  const user = await currentUser(request, env);
  return user ? { uid: user.uid, via: 'login' } : null;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_OPEN });
  const url = new URL(request.url);
  const q = url.searchParams;

  // 手机浏览器打开，或只能发 GET 的 webhook（带 url 参数）
  const webhookGet = request.method === 'GET' && (q.get('url') || q.get('link') || q.get('pdf_url'));
  if (request.method === 'GET' && !webhookGet) return formPage();
  if (request.method !== 'POST' && !webhookGet) return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB) return reply({ error: '还没绑定 D1 数据库（变量名 DB）' }, 503);

  const me = await identity(request, url, env);
  if (!me) return reply({ error: '缺少密钥：请配置 CAPTURE_KEY，或先在笔记站登录' }, 401);

  const incoming = await parseIncoming(request, url);
  if (incoming.error) return reply({ error: incoming.error }, 400);
  const bytes = incoming.bytes;
  if (!bytes || !bytes.byteLength) return reply({ error: '没收到文件：用 multipart 的 file 字段、原始二进制，或 JSON 里的 pdf(base64) / url' }, 400);
  if (bytes.byteLength > MAX_PDF) return reply({ error: '文件超过 20MB' }, 413);
  const detected = detectFile(bytes);
  if (!detected) return reply({ error: '只支持 PDF 或图片（PNG / JPEG / WebP / SVG）' }, 400);
  if (detected.kind === 'heic') return reply({ error: 'HEIC 请先转成 JPEG 或 PNG 再传' }, 400);

  const kind = detected.kind;
  const ext = kind !== 'pdf'
    ? (detected.mime === 'image/jpeg' ? 'jpg' : detected.mime === 'image/webp' ? 'webp'
      : detected.mime === 'image/svg+xml' ? 'svg' : 'png')
    : 'pdf';
  const filename = (incoming.filename || 'import.' + ext).replace(/[\r\n/\\]/g, '_').slice(0, 200);
  const sourceLabel = cleanLabel(incoming.source) || (incoming.format.includes('url') ? 'Webhook' : '快捷指令');
  const notebook = str(incoming.notebook, 60).trim() || DEFAULT_NOTEBOOK;
  const hash = await sha256(bytes);
  const now = Date.now();

  // 原始文件（PDF 或长图）存媒体库：key 由内容哈希派生，重复推送覆盖同一份，不堆垃圾
  let pdfUrl = '';
  if (q.get('keep') !== '0' && (env.BUCKET || env.MEDIA)) {
    const fileId = hash.slice(0, 32);
    const key = `${me.uid}/${fileId}`;
    try {
      if (env.BUCKET) await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: detected.mime } });
      else await env.MEDIA.put(key, bytes, { metadata: { name: filename, type: detected.mime, size: bytes.byteLength, createdAt: now } });
      pdfUrl = `${url.origin}/api/media/${me.uid}/${fileId}`;
    } catch (e) { pdfUrl = ''; }   // 存原件失败不影响导入正文
  }

  const conv = await toMarkdown(env, bytes, filename, detected.mime, kind);
  const md = conv.md;
  const mode = md ? 'markdown' : 'original';

  const title = (str(incoming.title, 300).trim()
    || firstHeading(md)
    || filename.replace(/\.(pdf|png|jpe?g|webp|svg|heic)$/i, '').replace(/[_-]+/g, ' ').trim()
    || '导入 ' + stamp(now)).replace(/[\r\n]+/g, ' ').slice(0, 200);

  const head = [
    '> 来源：' + (kind === 'pdf' ? 'PDF' : '长图') + ' 导入 · ' + sourceLabel,
    '> 保存于：' + stamp(now),
    '> 文件：' + filename + '（' + humanSize(bytes.byteLength) + '）'
  ];
  const parts = [head.join('\n')];
  if (md) parts.push(md);
  else parts.push('*（没能自动提取文字；请点下面的原始文件查看）*');
  if (pdfUrl) parts.push('---\n\n> 原始文件：[' + filename + '](' + pdfUrl + ')');
  const body = parts.join('\n\n').slice(0, MAX_MD);

  // PDF 和长图共用一个笔记本（nb_pdf_*），只是 noteId 前缀和标签不同
  const id = (kind === 'pdf' ? 'pdf_' : 'img_') + hash.slice(0, 16);
  const nbId = 'nb_pdf_' + me.uid;
  const tags = JSON.stringify([kind === 'pdf' ? 'PDF' : '长图', sourceLabel]);

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
      ).bind(me.uid, id, title, body, nbId, tags, now)
    ]);
  } catch (err) {
    return reply({ error: String((err && err.message) || err) }, 500);
  }

  const noteUrl = `${url.origin}/?n=${id}`;
  const out = {
    ok: true, noteId: id, title, notebook, noteUrl, pdfUrl, fileUrl: pdfUrl,
    kind, mime: detected.mime,
    mode, chars: md.length, tokens: conv.tokens || 0,
    format: incoming.format, size: bytes.byteLength
  };
  if (conv.error) out.warning = conv.error;

  const want = (q.get('format') || 'json').toLowerCase();
  if (want === 'md' || want === 'markdown') {
    return new Response(md || body, {
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', ...CORS_OPEN }
    });
  }
  if (want === 'html') {
    return new Response(htmlPage(title, md, `${filename} · ${humanSize(bytes.byteLength)} · ${stamp(now)} · ${kind === 'pdf' ? 'PDF' : '长图'} → Markdown`), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...CORS_OPEN }
    });
  }
  return reply(out);
}
