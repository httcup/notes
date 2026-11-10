// /api/ics  只做一件事：把公开共享的日历 ICS 拉回来，绕过 CORS
//   GET /api/ics?u=<encodeURIComponent(webcal://… 或 https://…)>
// 只放行 http/https，禁内网地址（防止被当成 SSRF 跳板）；内容解析全部在前端做
import { json, preflight, currentUser } from '../_lib.js';

const MAX_BYTES = 3 * 1024 * 1024;

function bad(msg, status = 400) {
  return json({ error: msg }, status);
}

/* 粗筛内网/本机，别让这个接口变成内网探测器 */
function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  // IPv4 字面量
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }
  // IPv6 字面量一律不放行
  if (h.includes(':')) return false;
  if (!/^[a-z0-9.-]+$/.test(h)) return false;
  return true;
}

function normalize(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  if (/^webcal:\/\//i.test(u)) u = u.replace(/^webcal:\/\//i, 'https://');
  if (/^http:\/\//i.test(u) === false && /^https:\/\//i.test(u) === false) {
    if (/^\/\//.test(u)) u = 'https:' + u;
    else return null;
  }
  try {
    const p = new URL(u);
    if (!hostAllowed(p.hostname)) return null;
    return p.toString();
  } catch (e) {
    return null;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'GET') return bad('method not allowed', 405);

  const me = await currentUser(request, env);
  if (!me) return bad('请先登录', 401);

  const target = normalize(new URL(request.url).searchParams.get('u'));
  if (!target) return bad('链接不对，需要 http(s) 或 webcal 开头的日历地址');

  let res;
  try {
    res = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: 'text/calendar, text/plain, */*',
        'user-agent': 'IvyNotes/1.0 (+https://n.139t.cn)'
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
      cf: { cacheTtl: 600, cacheEverything: true }
    });
  } catch (e) {
    return bad('拉不到这个地址，可能已失效或被墙：' + (e && e.message ? e.message : '网络错误'), 502);
  }

  if (!res.ok) return bad('对方返回 ' + res.status + '，检查一下这个日历是不是还在公开共享', 502);

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) return bad('日历文件太大（超过 3MB），换个时间段或精简一下', 413);

  let text = new TextDecoder('utf-8').decode(buf);
  // 有些服务吐 latin1，中文会乱码；出现大量替换字符就按 GBK/latin1 再解一次
  if ((text.match(/\uFFFD/g) || []).length > 3) {
    try { text = new TextDecoder('gbk').decode(buf); } catch (e) { /* 保持原样 */ }
  }
  if (text.indexOf('BEGIN:VCALENDAR') < 0) return bad('这个地址返回的不是日历文件（没有 VEVENT）', 415);

  return new Response(text, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-ivy-source': target.slice(0, 200)
    }
  });
}
