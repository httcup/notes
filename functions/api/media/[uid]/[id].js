// /api/media/:uid/:id  读取（公开，靠不可猜的 id）／删除（需本人令牌）
import { json, preflight, currentUser } from '../../../_lib.js';

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return preflight();
  const uid = String(params.uid || '');
  const id = String(params.id || '');
  if (!uid || !id) return json({ error: 'not found' }, 404);

  const key = `${uid}/${id}`;
  const store = env.BUCKET || env.MEDIA;
  if (!store) return json({ error: '服务端未绑定媒体存储' }, 503);

  if (request.method === 'DELETE') {
    const user = await currentUser(request, env);
    if (!user || user.uid !== uid) return json({ error: '无权限' }, 403);
    await store.delete(key);
    return json({ ok: true });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (env.BUCKET) {
    const obj = await env.BUCKET.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : obj.body, {
      headers: {
        'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable',
        etag: obj.httpEtag
      }
    });
  }

  const obj = await env.MEDIA.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!obj || !obj.value) return new Response('Not found', { status: 404 });
  const md = obj.metadata || {};
  return new Response(request.method === 'HEAD' ? null : obj.value, {
    headers: {
      'content-type': md.type || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable'
    }
  });
}
