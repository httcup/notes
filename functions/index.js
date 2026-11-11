// 首页补校验头：Cloudflare Pages 对 HTML 不发 ETag / Last-Modified，
// 浏览器没有校验依据，每次打开都要把整页（brotli 后 132KB）重新下载一遍。
// 这里按内容哈希生成一对稳定的 ETag / Last-Modified，命中条件请求就返回 304。
// 注意：生产环境会把 Function 设的 ETag 过滤掉，所以同时给 Last-Modified 做兜底。
export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  // HEAD 的 body 是空的（会算出空内容的哈希），所以只处理 GET
  if (url.pathname !== '/' || request.method !== 'GET') return next();

  const res = await next();
  if (!res.ok) return res;

  const buf = await res.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  const hex = Array.from(digest).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  const etag = '"' + hex + '"';

  // 由内容哈希派生一个稳定的「修改时间」（落在 2025 年内，避免出现未来时间）：内容变了时间才变
  const stamp = Date.UTC(2025, 0, 1) + (parseInt(hex.slice(0, 8), 16) % (365 * 86400)) * 1000;
  const lastModified = new Date(stamp).toUTCString();

  const headers = new Headers(res.headers);
  headers.set('etag', etag);
  headers.set('last-modified', lastModified);
  headers.set('cache-control', 'public, max-age=0, s-maxage=60, must-revalidate');

  const inm = request.headers.get('if-none-match');
  const ims = request.headers.get('if-modified-since');
  const fresh = (inm && inm === etag) || (!inm && ims && Date.parse(ims) >= stamp - 999);
  if (fresh) {
    headers.delete('content-length');
    return new Response(null, { status: 304, headers });
  }
  headers.set('content-length', String(buf.byteLength));
  return new Response(buf, { status: res.status, headers });
}
