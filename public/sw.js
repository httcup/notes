/* 随手笔记 Service Worker
   两件事：
   1) 离线可用：把应用外壳（HTML / 图标 / manifest）缓存下来，断网也能打开继续写；
   2) 到点提醒：把通知弹成系统通知，点通知回到对应笔记。

   缓存策略（刻意保守，避免把接口数据缓存成陈旧内容）：
   - 只有「首页导航」（/ 与 /index.html）做 network-first：联网时永远拿最新 HTML，断网回落缓存；
   - 同源的静态资源（js / png / webmanifest / vendor）走 stale-while-revalidate，先给缓存再后台更新；
   - /api/* 一律不接管：同步、上传、删除全部直连，失败由页面自己的重试逻辑处理；
   - 图床图片（img.139t.cn）单独一个缓存：缓存优先 + 后台刷新，重看不用再等几百 KB；
   - 其它路径（/admin、/s.html 等）完全不干预。
   缓存名带版本号（注册时 ?v=IVY_BUILD），发版即换新缓存，旧的在 activate 里清掉。 */

const BUILD = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'ivy-shell-' + BUILD;
const NAV_TIMEOUT = 3500;          // 联网时最多等这么久，超时就用缓存（地铁、弱网场景）
/* 图床图片缓存：故意不跟 BUILD 走，否则每次发版都要把几十 MB 图片重新下一遍 */
const IMG_CACHE = 'ivy-img-v1';
const IMG_HOSTS = ['img.139t.cn', 'pic.139t.cn'];
const IMG_MAX = 160;               // 最多留 160 张（约 60～90MB），超了删最早的

const SHELL = [
  '/index.html',
  '/manifest.webmanifest',
  '/version.js',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png'
];

const OFFLINE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>随手笔记 · 离线</title>
<style>
  html,body{height:100%;margin:0;background:#faf9f7;color:#1d1f23;
    font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;
    display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
  .box{max-width:340px}
  h1{font-size:17px;font-weight:600;margin:0 0 10px}
  p{font-size:13.5px;color:#6b7280;margin:0 0 18px}
  button{padding:9px 18px;border:1px solid #e4e6eb;background:#fff;border-radius:10px;
    font-size:13.5px;color:#1d1f23}
  @media (prefers-color-scheme:dark){
    html,body{background:#0e1014;color:#e8eaed}
    button{background:#16191f;border-color:#262b33;color:#e8eaed}
    p{color:#9aa3ad}
  }
</style></head><body><div class="box">
  <h1>这一页还没存到本机</h1>
  <p>第一次打开需要联网，之后就离线可用了。连上网络再打开一次即可。</p>
  <button onclick="location.reload()">重新加载</button>
</div></body></html>`;

/* ---------- 安装：预缓存外壳 ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个下，单个资源 404 不至于让整次安装失败
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!res || !res.ok) return;
        if (url === '/index.html') { await putShell(cache, res); return; }
        await cache.put(url, await withoutRedirect(res)).catch(() => {});
      } catch (err) {}
    }));
    await self.skipWaiting();
  })());
});

/* ---------- 激活：清掉旧版本缓存，立刻接管 ---------- */
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => (k.startsWith('ivy-shell-') && k !== CACHE) ||
                       (k.startsWith('ivy-img-') && k !== IMG_CACHE)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------- 工具 ---------- */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
  });
}

const isShellPath = (pathname) => pathname === '/' || pathname === '/index.html';

/* Safari 不允许 Service Worker 把「带重定向」的响应交给导航请求：
   直接 fetch('/') 会被 Cloudflare 308 到 /index.html，拿到的响应 redirected=true，
   缓存在离线时返回就会报 "Response served by service worker has redirections"。
   这里统一重包一次，清掉 redirected 标记，再缓存 / 返回。 */
async function withoutRedirect(res) {
  if (!res || !res.redirected) return res;
  try {
    const body = await res.blob();
    return new Response(body, { status: 200, statusText: 'OK', headers: res.headers });
  } catch (err) {
    return new Response('', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}
async function putShell(cache, res) {
  const clean = await withoutRedirect(res);
  await Promise.all([
    cache.put('/index.html', clean.clone()).catch(() => {}),
    cache.put('/', clean.clone()).catch(() => {})
  ]);
  return clean;
}

/* 首页：先网络（带超时），失败回落缓存 */
async function navigationResponse(req) {
  const cache = await caches.open(CACHE);
  try {
    // 不直接 fetch(req)：打开 / 时会被 308 到 /index.html，响应带 redirected，Safari 拒收
    const res = await withTimeout(fetch(new Request('/index.html', { cache: 'no-cache' })), NAV_TIMEOUT);
    if (res && res.ok) return await putShell(cache, res);
    throw new Error('bad status ' + (res && res.status));
  } catch (err) {
    let cached = (await cache.match('/index.html')) || (await cache.match('/'));
    if (cached) return await withoutRedirect(cached);
    return new Response(OFFLINE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
}

/* 静态资源：先给缓存，同时后台拉新的存进去 */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const key = new Request(req.url, { method: 'GET' });
  const cached = await cache.match(key, { ignoreSearch: true });
  const network = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  const res = await network;
  if (res) return res;
  return new Response('', { status: 504, statusText: 'Offline' });
}

/* 图床图片：有缓存就先给（瞬间出来），同时后台更新；单张几百 KB，缓一轮够用很久 */
async function pruneImg(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length <= IMG_MAX) return;
    for (const k of keys.slice(0, keys.length - IMG_MAX)) await cache.delete(k);
  } catch (err) {}
}
async function imgCacheFirst(req) {
  const cache = await caches.open(IMG_CACHE);
  const hit = await cache.match(req);
  const net = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone()).then(() => pruneImg(cache)).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  if (hit) return hit;
  const res = await net;
  return res || new Response('', { status: 504, statusText: 'Offline' });
}

/* ---------- 请求拦截 ---------- */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                        // 上传 / 同步 / 删除：直连

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) {
    // 图床图片缓存一份：移动网络下重看笔记不用再等一遍
    if (req.destination === 'image' && IMG_HOSTS.indexOf(url.hostname) >= 0) {
      e.respondWith(imgCacheFirst(req));
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) return;             // 接口：不缓存，失败交给页面重试

  if (req.mode === 'navigate') {
    if (!isShellPath(url.pathname)) return;                 // /admin、/s.html 等照常走网络
    e.respondWith(navigationResponse(req));
    return;
  }

  // 只缓存确实是静态资源的那些后缀，避免误伤
  if (!/\.(?:js|mjs|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|webmanifest|json|txt)$/i.test(url.pathname)
      && url.pathname !== '/apple-touch-icon.png') return;

  e.respondWith(staleWhileRevalidate(req));
});

/* ---------- 通知：点一下回到对应笔记 ---------- */
self.addEventListener('notificationclick', (e) => {
  const data = (e.notification && e.notification.data) || {};
  e.notification.close();
  const noteId = data.noteId || '';
  const target = new URL(noteId ? '/?n=' + encodeURIComponent(noteId) : '/', self.location.origin).href;

  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (!String(c.url).startsWith(self.location.origin)) continue;
      try { await c.focus(); } catch (err) {}
      c.postMessage({ type: 'ivy-open-note', noteId });
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
