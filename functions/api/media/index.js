// /api/media  列表 + 上传（文件存在 KV，单文件上限 20MB；绑了 R2 会优先用 R2）
import { json, preflight, currentUser, randomHex } from '../../_lib.js';

const MAX = 20 * 1024 * 1024;

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();

  const user = await currentUser(request, env);
  if (!user) return json({ error: '未登录或口令不正确' }, 401);
  if (!env.MEDIA && !env.BUCKET) return json({ error: '服务端未绑定媒体存储' }, 503);

  const uid = user.uid;

  if (request.method === 'GET') {
    const items = [];
    if (env.MEDIA) {
      let cursor;
      for (let i = 0; i < 10; i++) {
        const page = await env.MEDIA.list({ prefix: uid + '/', cursor, limit: 1000 });
        for (const k of page.keys || []) {
          const md = k.metadata || {};
          const id = k.name.slice(uid.length + 1);
          items.push({
            id,
            url: `/api/media/${uid}/${id}`,
            name: md.name || id,
            size: md.size || 0,
            type: md.type || 'application/octet-stream',
            createdAt: md.createdAt || 0
          });
        }
        if (page.list_complete) break;
        cursor = page.cursor;
      }
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return json({ items });
  }

  if (request.method === 'POST') {
    const type = request.headers.get('content-type') || '';
    if (!type.includes('multipart/form-data')) return json({ error: '请用 multipart/form-data 上传' }, 415);

    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return json({ error: '缺少 file 字段' }, 400);
    if (file.size > MAX) return json({ error: '文件超过 20MB' }, 413);

    const id = randomHex(16);
    const key = `${uid}/${id}`;
    const buf = await file.arrayBuffer();
    const meta = {
      name: file.name || 'file',
      type: file.type || 'application/octet-stream',
      size: file.size,
      createdAt: Date.now()
    };

    if (env.BUCKET) {
      await env.BUCKET.put(key, buf, { httpMetadata: { contentType: meta.type } });
    } else {
      await env.MEDIA.put(key, buf, { metadata: meta });
    }

    return json({ id, url: `/api/media/${uid}/${id}`, ...meta });
  }

  return json({ error: 'Method not allowed' }, 405);
}
