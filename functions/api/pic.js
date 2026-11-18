// /api/pic  自家图床（pic.139t.cn → img.139t.cn）的上传代理
// 只给已登录用户用；长期上传 token 只存在服务端（PIC_TOKEN），不下发到浏览器。
// 这样浏览器不跨域、不碰密钥，换设备也不用各存一份 token。
import { json, preflight, currentUser, cloudUploadAllowed } from '../_lib.js';

const DEFAULT_BASE = 'https://pic.139t.cn';

function base(env) {
  return String(env.PIC_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

function notReady(env) {
  return json({ error: '图床密钥还没配置（服务端缺 PIC_TOKEN）', code: 'pic_not_configured' }, 503);
}

async function callPic(env, path, init) {
  let r;
  try {
    r = await fetch(base(env) + path, init);
  } catch (e) {
    throw Object.assign(new Error('连不上图床：' + (e.message || '网络错误')), { status: 502 });
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) {
    const msg = d.error || d.message || ('图床返回 HTTP ' + r.status);
    throw Object.assign(new Error(msg), { status: r.status === 401 ? 502 : (r.status || 502) });
  }
  return d;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();

  const user = await currentUser(request, env);
  if (!user) return json({ error: '未登录或口令不正确' }, 401);
  // 图床只给白名单账号用，其余账号存本机（前端收到 403 会退回内嵌图片）
  if (!(await cloudUploadAllowed(env, user))) {
    return json({ error: '当前账号未开通云图床，图片只存本机', code: 'not_allowed' }, 403);
  }
  if (!env.PIC_TOKEN) return notReady(env);

  const url = new URL(request.url);

  // 列表：给「媒体库」用，按时间倒序
  if (request.method === 'GET') {
    const qs = new URLSearchParams();
    qs.set('limit', String(Math.min(Math.max(Number(url.searchParams.get('limit') || 60), 1), 100)));
    if (url.searchParams.get('cursor')) qs.set('cursor', url.searchParams.get('cursor'));
    if (url.searchParams.get('prefix')) qs.set('prefix', url.searchParams.get('prefix'));
    try {
      const d = await callPic(env, '/api/images?' + qs.toString(), {
        headers: { authorization: 'Bearer ' + env.PIC_TOKEN }
      });
      const items = (d.items || []).map((it) => ({
        id: it.key,
        key: it.key,
        url: it.url,
        name: String(it.key || '').split('/').pop(),
        size: it.size || 0,
        type: it.type || '',
        createdAt: Date.parse(it.uploaded) || 0,
        pic: true
      }));
      return json({ items, cursor: d.cursor || null, count: items.length });
    } catch (e) {
      return json({ error: e.message || '读取图床列表失败' }, e.status || 502);
    }
  }

  // 上传：multipart 里取 file，原样转发给图床（图床做魔数校验、哈希命名、去重）
  if (request.method === 'POST') {
    const type = request.headers.get('content-type') || '';
    if (!type.includes('multipart/form-data')) return json({ error: '请用 multipart/form-data 上传' }, 415);

    const form = await request.formData();
    let file = form.get('file');
    if (!file || typeof file === 'string') {
      for (const v of form.values()) {
        if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function') { file = v; break; }
      }
    }
    if (!file || typeof file === 'string') return json({ error: '缺少 file 字段' }, 400);

    const buf = await file.arrayBuffer();
    if (!buf.byteLength) return json({ error: '文件是空的' }, 400);

    try {
      const d = await callPic(env, '/api/upload', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + env.PIC_TOKEN,
          'content-type': file.type || 'application/octet-stream'
        },
        body: buf
      });
      return json({
        key: d.key,
        url: d.url,
        markdown: d.markdown,
        name: file.name || String(d.key || '').split('/').pop(),
        size: d.size || buf.byteLength,
        type: d.type || file.type,
        dedup: !!d.dedup,
        pic: true
      });
    } catch (e) {
      return json({ error: e.message || '上传到图床失败' }, e.status || 502);
    }
  }

  // 删除：?key=2026/11/xxxx.png
  if (request.method === 'DELETE') {
    const key = url.searchParams.get('key') || '';
    if (!key) return json({ error: '缺少 key' }, 400);
    try {
      await callPic(env, '/api/images?key=' + encodeURIComponent(key), {
        method: 'DELETE',
        headers: { authorization: 'Bearer ' + env.PIC_TOKEN }
      });
      return json({ ok: true });
    } catch (e) {
      return json({ error: e.message || '删除失败' }, e.status || 502);
    }
  }

  return json({ error: 'Method not allowed' }, 405);
}
