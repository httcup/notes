// /s/<slug> → 交给静态的分享页 public/s.html（页面自己从路径里取 slug）
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  try {
    return await env.ASSETS.fetch(new URL('/s.html', url.origin));
  } catch (e) {
    return Response.redirect(url.origin + '/s.html?slug=' + encodeURIComponent(url.pathname.split('/').pop() || ''), 302);
  }
}
