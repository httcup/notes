// 首页补 ETag：Cloudflare Pages 对 HTML 不发 ETag / Last-Modified，
// 浏览器没有校验依据，每次打开都要把整页（brotli 后 132KB）重新下载一遍。
// 这里给 / 加一个内容哈希式 ETag，命中 If-None-Match 就返回 304。
export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  // HEAD 的 body 是空的（会算出空内容的哈希），所以只处理 GET
  if (url.pathname !== '/' || request.method !== 'GET') return next();

  const res = await next();
  if (!res.ok) return res;

  const buf = await res.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const etag = '"' + Array.from(new Uint8Array(digest)).slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0')).join('') + '"';

  const headers = new Headers(res.headers);
  headers.set('etag', etag);
  headers.set('cache-control', 'public, max-age=0, s-maxage=60, must-revalidate');

  if (request.headers.get('if-none-match') === etag) {
    headers.delete('content-length');
    return new Response(null, { status: 304, headers });
  }
  headers.set('content-length', String(buf.byteLength));
  return new Response(buf, { status: res.status, headers });
}
