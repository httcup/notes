// 共享工具：CORS、口令哈希、签名令牌、身份识别

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-ivy-key, authorization',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS'
};

export { CORS };

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS }
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

const enc = new TextEncoder();

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password, saltHex, iter = 60000) {
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a, b) {
  const A = String(a == null ? '' : a);
  const B = String(b == null ? '' : b);
  if (A.length !== B.length) return false;
  let d = 0;
  for (let i = 0; i < A.length; i++) d |= A.charCodeAt(i) ^ B.charCodeAt(i);
  return d === 0;
}

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(str).length % 4)) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function signToken(payload, secret) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  return body + '.' + b64urlEncode(await hmac(secret, body));
}

export async function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expect = b64urlEncode(await hmac(secret, body));
  if (!safeEqual(expect, sig)) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!p || !p.u) return null;
    if (p.e && p.e < Date.now()) return null;
    return p;
  } catch (e) {
    return null;
  }
}

// 账号是否已失效：同一个 isolate 里缓存 30 秒，避免每个请求都多一次数据库往返。
// 两种情况都算失效：
//   1) 账号被停用（users.disabled = 1）
//   2) 账号已注销 —— users 里那一行被删掉了
// 第 2 条必须有：令牌是 HMAC 签名的、90 天有效，注销后若不校验账号是否还在，
// 旧令牌还能继续把笔记写进一个「已经不存在」的账号，等于注销没销干净。
const accountCache = new Map();
async function accountInvalid(env, uid) {
  if (!env || !env.DB || !uid || uid === 'owner') return false; // 主人账号不在 users 表里
  const hit = accountCache.get(uid);
  if (hit && Date.now() - hit.at < 30000) return hit.v;
  let v = false;
  try {
    const row = await env.DB.prepare('SELECT disabled FROM users WHERE id = ?1').bind(uid).first();
    v = !row || !!row.disabled;
  } catch (e) {
    v = false; // 老库没有这一列时不影响正常使用
  }
  accountCache.set(uid, { v, at: Date.now() });
  return v;
}

// 账号被删除后立刻清掉本实例的缓存，否则同一个实例里旧令牌还能再撑 30 秒
// （其它实例仍可能有最长 30 秒的旧缓存，这是用内存换掉每个请求一次数据库往返的代价）
export function forgetAccount(uid) {
  accountCache.delete(uid);
}

// 支持两种身份：Bearer 令牌（多用户）／x-ivy-key 单口令（主人账号，兼容旧客户端）
// 云上传白名单：图床 / 云端文件只给指定账号用，其余账号一律存本机。
// PIC_ALLOW 里填 uid 或账号名，逗号分隔；不配时只放行 ADMIN_UID（默认 owner）。
// 显式写 "*" 才全放开。
export function cloudUploadAllowed(env, user) {
  if (!user) return false;
  const raw = String((env && env.PIC_ALLOW) || (env && env.ADMIN_UID) || 'owner').trim();
  if (raw === '*') return true;
  const list = raw.split(/[,，\s]+/).filter(Boolean).map((s) => s.toLowerCase());
  return list.includes(String(user.uid || '').toLowerCase()) || list.includes(String(user.name || '').toLowerCase());
}

export async function currentUser(request, env) {
  const authz = request.headers.get('authorization') || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const p = await verifyToken(m[1], env.IVY_SECRET);
    if (!p) return null;
    if (await accountInvalid(env, p.u)) return null; // 停用或已注销的账号，旧令牌一起失效
    return { uid: p.u, name: p.n || '' };
  }
  const legacy = request.headers.get('x-ivy-key') || '';
  if (env.IVY_KEY && safeEqual(legacy, env.IVY_KEY)) return { uid: 'owner', name: '主人' };
  return null;
}
