// /api/capture —— 微博 / 微信 / 任意网页 → 笔记（外部剪藏入口）
//
// 仓库里 /api/sync 是全量双向同步（只认登录态），/api/notesfeed、/api/share 都是「往外读」，
// 缺的是一条「往里写」的通道。这个端点就是那条通道，给 iOS 快捷指令、书签、分享菜单用。
//
// 部署：Cloudflare Pages 加一个 Secret「CAPTURE_KEY」（自己生成的一长串随机字符）
//       可选「CAPTURE_UID」，默认 owner（主人账号，和云同步登录的主人口令是同一个空间）
//       不需要改数据库、不需要改 444KB 的 public/index.html、不需要发前端版本。
//
// POST /api/capture?k=<CAPTURE_KEY>   或请求头 x-capture-key
//   body { url, title, text, source, notebook }
//   url 与 text 至少给一个；text 是分享时带上的标题/摘要/选中文字，最关键
//   → { ok, noteId, title, notebook, mode }   mode: full=抓到正文 / link=只存了链接
// GET  /api/capture?k=<CAPTURE_KEY>  → 手机浏览器里粘贴链接用的极简表单
//
// 已登录的浏览器也可以不带 key 直接调（走 currentUser），方便以后在前端加按钮。
//
// 抓取策略：
//   微信公众号 / 普通网页 → 直连。先在全量 HTML 上剔除脚本，再按 div 标签栈精确切出
//   #js_content 容器（微信页面 3MB+，正文常在 600KB 之后，粗暴 slice 会把 JS 当正文写进笔记）。
//   微博 → 直连必被 Sina Visitor System 拦，改用 r.jina.ai Reader 拿正文（CAPTURE_JINA=0 可关闭）。
//   任何一路抓不到或不干净，都降级为「标题 + 原链接 + 分享时带过来的文字」。

import { currentUser, safeEqual, CORS } from '../_lib.js';

const CORS_OPEN = {
  ...CORS,
  'access-control-allow-headers': 'content-type, x-ivy-key, authorization, x-capture-key'
};

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAX_BODY = 60000;
const MAX_HTML = 4000000; // 微信图文单页可达 3.6MB，正文位置远在 400KB 之后

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_OPEN }
  });
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', times: '×' };
  const cp = (n) => { try { return String.fromCodePoint(n); } catch (e) { return ''; } };
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => cp(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => cp(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, k) => (k.toLowerCase() in map ? map[k.toLowerCase()] : m));
}

/** 访客验证页 / 平台通用占位标题，绝不能拿来当笔记标题 */
function cleanTitle(t) {
  const s = String(t || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (/^(sina visitor system|微博正文|微博|微博-随时随地发现新鲜事|微信公众平台|页面不存在|访问验证|环境异常|验证码)/i.test(s)) return '';
  return s.slice(0, 200);
}

function attr(html, re) {
  const m = re.exec(html);
  return m ? decodeEntities(m[1].trim()) : '';
}

/** 从 HTML 里取标题；优先 og:title / 微信的 msg_title，其次 <title> */
export function pickMeta(html) {
  const h = String(html || '');
  const title = attr(h, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)
    || attr(h, /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)/i)
    || attr(h, /var\s+msg_title\s*=\s*["']([^"']+)/i)
    || attr(h, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = attr(h, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i)
    || attr(h, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i);
  return { title: cleanTitle(title), desc: desc.trim() };
}

/** 极简 HTML → Markdown：够用于公众号长文，不做完整 DOM 解析 */
export function htmlToMd(html) {
  let s = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /data-src=["']([^"']+)/i.exec(tag)
      || /\bsrc=["']([^"']+)/i.exec(tag);
    if (!src) return '';
    const u = decodeEntities(src[1].trim());
    return /^(https?:)?\/\//i.test(u) ? `\n![](${u})\n` : '';
  });
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (m, n) => `\n\n${'#'.repeat(Math.min(6, Number(n) + 1))} `)
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|blockquote|tr|ul|ol|figure)>/gi, '\n\n')
    .replace(/<\/(td|th)>/gi, ' · ')
    .replace(/<(strong|b)\b[^>]*>/gi, '**')
    .replace(/<\/(strong|b)>/gi, '**')
    .replace(/<(em|i)\b[^>]*>/gi, '*')
    .replace(/<\/(em|i)>/gi, '*')
    .replace(/<a\b[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (m, href, label) => `[${label.replace(/<[^>]+>/g, '').trim() || href}](${href})`)
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s).replace(/[ \t]+\n/g, '\n')
    .replace(/^\s*[-*·]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** 只留 http(s)，挡掉内网 / 云元数据地址，避免这个「能写库的端点」被拿去探内网 */
export function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|metadata)/.test(h)) return null;
  return u;
}

/** 微博 → 交给 Reader 的规范化地址：普通状态转移动端详情页，头条文章转 p/show */
function jinaTargets(u) {
  const s = u.toString();
  const article = /(?:id=|\/)(2309\d{13,})/.exec(s);
  if (article) return [`https://weibo.com/ttarticle/p/show?id=${article[1]}`];
  const nums = (s.match(/\d{10,20}/g) || []).sort((a, b) => b.length - a.length);
  return nums.length ? [`https://m.weibo.cn/detail/${nums[0]}`] : [];
}

/** 直连候选；微博把 id 藏在 hash 里时服务端收不到，转成带 query 的地址再试 */
function fetchCandidates(u) {
  const out = [u.toString()];
  if (/weibo\.(com|cn)/i.test(u.hostname)) {
    const id = /(?:id=|\/)(2309\d{13,})/.exec(u.toString());
    if (id) out.push(`https://weibo.com/ttarticle/p/show?id=${id[1]}`);
  }
  return [...new Set(out)];
}

async function fetchText(target, headers, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(target, { headers, redirect: 'follow', signal: ctl.signal });
  } finally { clearTimeout(timer); }
}

/** 在【完整】HTML 上先剔掉脚本/样式。切片段之后再剔，一定会漏掉被截断的 <script> */
function stripNoise(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '');
}

/** 按标签栈切出容器内部 HTML，避免把容器之后的整页脚本一起带进笔记 */
function sliceContainer(html, tag, openRe) {
  const m = openRe.exec(html);
  if (!m) return '';
  const start = m.index + m[0].length;
  const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
  re.lastIndex = start;
  let depth = 1, t;
  while ((t = re.exec(html))) {
    if (/\/>$/.test(t[0])) continue;
    depth += t[1] ? -1 : 1;
    if (!depth) return html.slice(start, t.index);
  }
  return html.slice(start, start + MAX_BODY);
}

function mainContent(html) {
  const h = String(html || '');
  const wx = sliceContainer(h, 'div', /<div\b[^>]*\bid=["']js_content["'][^>]*>/i);
  if (wx) return wx.slice(0, MAX_BODY);
  const art = sliceContainer(h, 'article', /<article\b[^>]*>/i);
  if (art) return art.slice(0, MAX_BODY);
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(h);
  return (body ? body[1] : h).slice(0, MAX_BODY);
}

/** 抓到的是脚本碎片、访客验证页、还是解码失败的乱码？宁可只存链接，也不写脏正文 */
function looksLikeGarbage(md) {
  const s = String(md || '');
  if (!s) return true;
  if (/Sina Visitor System|请输入验证码|访问验证|环境异常|页面不存在/i.test(s)) return true;
  if ((s.match(/\uFFFD/g) || []).length > 3) return true;
  const marks = [/\bfunction\s*\(/, /\btypeof\s+[a-z]/i, /Object\.defineProperty/,
    /\bmodule\.exports/, /\bvar\s+\w+\s*=/, /document\.addEventListener/, /window\.\w+\s*=/,
    /=>/, /\}\)\s*\(/];
  let hits = 0;
  for (const re of marks) if (re.test(s)) hits++;
  if (hits >= 2) return true;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (hits >= 1 && s.length > 200 && cjk / s.length < 0.02) return true;
  return false;
}

/** 按页面声明的 charset 解码。GBK 页面用 UTF-8 硬解会得到「锟斤拷」，这里判失败降级 */
async function readHtml(res) {
  const buf = await res.arrayBuffer();
  const ct = res.headers.get('content-type') || '';
  let cs = (/charset\s*=\s*([\w-]+)/i.exec(ct) || [])[1] || '';
  if (!cs) {
    const head = new TextDecoder('utf-8').decode(buf.slice(0, 4096));
    cs = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) || [])[1] || 'utf-8';
  }
  const c = cs.toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = ['gbk', 'gb2312', 'gb18030'].includes(c) ? 'gb18030' : 'utf-8';
  let dec;
  try { dec = new TextDecoder(want, { fatal: true }); }
  catch (e) { dec = new TextDecoder('utf-8', { fatal: false }); }
  try { return dec.decode(buf.slice(0, MAX_HTML)); }
  catch (e) { return '\uFFFD\uFFFD\uFFFD\uFFFD'; }
}

/** 微博直连必被访客系统挡，用公开 Reader 拿渲染后的 Markdown（可用 CAPTURE_JINA=0 关闭） */
async function grabViaJina(target) {
  try {
    const res = await fetchText('https://r.jina.ai/' + target,
      { 'user-agent': UA, 'accept': 'text/plain' }, 12000);
    if (!res.ok) return null;
    const raw = (await res.text()).slice(0, MAX_BODY * 2);
    const title = (/^Title:\s*(.+)$/m.exec(raw) || [])[1] || '';
    const i = raw.search(/^Markdown Content:\s*$/m);
    if (i < 0) return null;
    let md = raw.slice(i).replace(/^Markdown Content:\s*/m, '').trim();
    // 微博详情页的 ### 作者 / #### 时间 / #### 关注 都是元信息，不是正文也不是标题
    if (/m\.weibo\.cn\/(detail|status)/.test(target)) {
      md = md.replace(/^#{1,6}[^\n]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    }
    if (md.length < 40 || looksLikeGarbage(md)) return null;
    return { title: cleanTitle(title), md: md.slice(0, MAX_BODY), mode: 'full', via: 'reader' };
  } catch (e) { return null; }
}

async function grab(rawUrl, env) {
  const u = safeUrl(rawUrl);
  if (!u) return { title: '', md: '', mode: 'link' };
  if (/weibo\.(com|cn)/i.test(u.hostname) && (!env || env.CAPTURE_JINA !== '0')) {
    for (const target of jinaTargets(u)) {
      const got = await grabViaJina(target);
      if (got) return got;
    }
  }
  for (const target of fetchCandidates(u)) {
    try {
      const res = await fetchText(target, {
        'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', 'accept': 'text/html,*/*'
      }, 8000);
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!/html|text/i.test(ct)) continue;
      const raw = await readHtml(res);
      const meta = pickMeta(raw);           // head 里的 og:title 要在剔脚本之前取
      const md = htmlToMd(mainContent(stripNoise(raw)));
      if (looksLikeGarbage(md)) {
        if (meta.title) return { title: meta.title, md: '', mode: 'link', via: 'link' };
        continue;
      }
      if (md.length >= 60) return { title: meta.title, md: md.slice(0, MAX_BODY), mode: 'full', via: 'direct' };
      if (meta.title) return { title: meta.title, md: '', mode: 'link', via: 'link' };
    } catch (e) { /* 超时 / 反爬 → 试下一个，最后降级 */ }
  }
  return { title: '', md: '', mode: 'link' };
}

async function noteIdFor(url) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return 'cap_' + Array.from(new Uint8Array(buf)).slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

function stamp(ts) {
  return new Date(ts + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) + '（北京时间）';
}

async function identity(request, url, env) {
  const key = request.headers.get('x-capture-key') || url.searchParams.get('k') || '';
  if (env.CAPTURE_KEY && key && safeEqual(key, env.CAPTURE_KEY)) {
    return { uid: env.CAPTURE_UID || 'owner', via: 'key' };
  }
  const user = await currentUser(request, env);
  return user ? { uid: user.uid, via: 'login' } : null;
}

function formPage() {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>存到我的笔记</title>
<style>body{margin:0;padding:24px;background:#f7f8f9;color:#1c1f22;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
.wrap{max-width:520px;margin:0 auto}h1{font:500 19px/1.4 Georgia,"Songti SC",serif;margin:0 0 4px}
p{color:#70767c;font-size:13px;margin:0 0 18px}label{display:block;font-size:13px;color:#464b50;margin:14px 0 6px}
input,textarea{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #e6e9ec;border-radius:10px;background:#fff;font:inherit;outline:none}
input:focus,textarea:focus{border-color:#287a52}textarea{min-height:76px;resize:vertical}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:10px;background:#287a52;color:#fff;font:500 15px inherit}
button:disabled{opacity:.55}#msg{margin-top:14px;font-size:13px;color:#1b5c3c;min-height:20px}</style></head>
<body><div class="wrap"><h1>存到我的笔记</h1>
<p>把微博 / 微信文章的链接粘进来，会自动存进「剪藏」笔记本，打开笔记站就能看到。</p>
<form id="f"><label for="u">文章链接</label><input id="u" type="url" placeholder="https://..." required>
<label for="t">标题或摘抄（选填，抓不到正文时全靠它）</label><textarea id="t" placeholder="粘贴标题、选中文字或想记的一句话"></textarea>
<button id="b" type="submit">保存</button></form><div id="msg"></div></div>
<script>
const key = new URLSearchParams(location.search).get('k') || '';
history.replaceState(null, '', location.pathname);
const f = document.getElementById('f'), b = document.getElementById('b'), msg = document.getElementById('msg');
f.onsubmit = async (e) => {
  e.preventDefault(); b.disabled = true; b.textContent = '正在保存…'; msg.textContent = '';
  try {
    const r = await fetch(location.pathname, { method:'POST',
      headers:{ 'content-type':'application/json', 'x-capture-key':key },
      body: JSON.stringify({ url: document.getElementById('u').value.trim(),
                            text: document.getElementById('t').value.trim(), source:'manual' }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    msg.textContent = '已存进「' + d.notebook + '」：' + d.title + (d.mode === 'link' ? '（只存到链接，正文没抓到）' : '');
    f.reset();
  } catch (err) { msg.textContent = '没成功：' + err.message; }
  finally { b.disabled = false; b.textContent = '保存'; }
};
</script></body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...CORS_OPEN }
  });
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_OPEN });
  const url = new URL(request.url);

  if (request.method === 'GET') return formPage();
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB) return reply({ error: '还没绑定 D1 数据库（变量名 DB）' }, 503);

  const me = await identity(request, url, env);
  if (!me) return reply({ error: '缺少剪藏密钥：请配置 CAPTURE_KEY，或先在笔记站登录' }, 401);

  const body = await request.json().catch(() => ({}));
  const text = str(body.text, 20000).trim();
  const rawUrl = str(body.url, 2000).trim();
  const clientTitle = str(body.title, 300).trim();
  if (!rawUrl && !text) return reply({ error: 'url 和 text 至少给一个' }, 400);
  if (rawUrl && !safeUrl(rawUrl)) return reply({ error: '这个链接不能抓取' }, 400);

  const source = ['wechat', 'weibo', 'web', 'manual'].includes(body.source) ? body.source : 'web';
  const sourceLabel = { wechat: '微信', weibo: '微博', web: '网页', manual: '手动' }[source];
  const notebook = str(body.notebook, 60).trim() || '剪藏';

  // 客户端带过来的内容优先；服务端抓取只用来补全，抓不到就降级
  const grabbed = rawUrl ? await grab(rawUrl, env) : { title: '', md: '', mode: 'link', via: 'link' };
  // 微博详情页没有可用 <title>，从正文里挑第一行像话的文字当标题
  const autoTitle = (grabbed.md || '').split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim())
    .find((l) => l.length >= 8 && !/^https?:/.test(l)) || '';
  const title = (clientTitle || grabbed.title || text.split('\n')[0] || autoTitle || '剪藏 ' + stamp(Date.now()))
    .replace(/[\r\n]+/g, ' ').slice(0, 200);

  const lines = [`> 来源：${sourceLabel}`, `> 保存于：${stamp(Date.now())}`];
  if (rawUrl) lines.push(`> 原链接：${rawUrl}`);
  // text 是分享时带过来的摘抄/选中文字；只有当它本身就是标题时才不重复写一遍
  const picked = text && text !== clientTitle ? text : '';
  const parts = [lines.join('\n')];
  if (picked) parts.push(picked);
  if (grabbed.md) parts.push(grabbed.md);
  else parts.push('*（正文没能自动抓取，点上面的原链接查看）*');
  const content = parts.join('\n\n').slice(0, 400000);

  const now = Date.now();
  const id = await noteIdFor(rawUrl || text.slice(0, 200));
  const nbId = 'nb_capture_' + me.uid;
  const tags = JSON.stringify(['剪藏', sourceLabel]);

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
      ).bind(me.uid, id, title, content, nbId, tags, now)
    ]);
  } catch (err) {
    return reply({ error: String((err && err.message) || err) }, 500);
  }

  return reply({ ok: true, noteId: id, title, notebook, mode: grabbed.md ? 'full' : 'link', via: grabbed.via || 'link', noteUrl: url.origin + '/?n=' + id });
}
