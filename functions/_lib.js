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

// 支持两种身份：Bearer 令牌（多用户）／x-ivy-key 单口令（主人账号，兼容旧客户端）
export async function currentUser(request, env) {
  const authz = request.headers.get('authorization') || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const p = await verifyToken(m[1], env.IVY_SECRET);
    return p ? { uid: p.u, name: p.n || '' } : null;
  }
  const legacy = request.headers.get('x-ivy-key') || '';
  if (env.IVY_KEY && safeEqual(legacy, env.IVY_KEY)) return { uid: 'owner', name: '主人' };
  return null;
}
