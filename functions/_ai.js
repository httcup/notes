// AI 接口配置的共用部分：地址归一化、内网拦截、密钥加密存储、读取配置
//
// 设计前提：key 是用户自己的，站点不内置任何 key。
// 但也不能让 key 停在浏览器里 —— 存进账号（加密）后，换设备登录就能直接用，
// 前端只拿得到掩码，页面源码与 localStorage 里都没有原值。

const enc = new TextEncoder();

export function b64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(s) {
  const bin = atob(String(s || ''));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function aesKey(env) {
  if (!env.IVY_SECRET) throw new Error('服务端没配置 IVY_SECRET，暂时不能保存密钥');
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('ivy.ai.v1|' + env.IVY_SECRET));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealKey(env, plain) {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  return b64(iv) + '.' + b64(ct);
}

export async function openKey(env, stored) {
  if (!stored || String(stored).indexOf('.') < 0) return '';
  const [ivs, cts] = String(stored).split('.');
  const key = await aesKey(env);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivs) }, key, unb64(cts));
  return new TextDecoder().decode(pt);
}

export function maskKey(k) {
  if (!k) return '';
  return k.length <= 10 ? '••••••' : k.slice(0, 3) + '…' + k.slice(-4);
}

/** 只填域名、粘了完整端点、末尾多斜杠，都在这里收拾干净 */
export function normalizeBase(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/chat\/completions$/i, '');
  return s;
}

/** 服务端要替用户去请求这个地址，必须挡住内网与云元数据，免得变成 SSRF 跳板 */
export function baseBlockReason(base) {
  let u;
  try { u = new URL(base); } catch (e) { return '地址格式不对'; }
  if (!/^https?:$/.test(u.protocol)) return '只支持 http / https';
  const h = u.hostname.toLowerCase();
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|metadata\.)/.test(h)
      || /\.local$/.test(h)) {
    return '不能填内网 / 本机地址';
  }
  return '';
}

export async function loadAiConfig(env, uid) {
  const row = await env.DB.prepare(
    'SELECT base_url, model, key_enc, updated_at FROM ai_config WHERE user_id = ?1'
  ).bind(uid).first();
  if (!row) return null;
  let key = '';
  let broken = false;
  try { key = await openKey(env, row.key_enc); } catch (e) { broken = true; }
  return {
    baseUrl: row.base_url || '',
    model: row.model || '',
    key,
    keyEnc: row.key_enc || '',
    broken,
    updatedAt: row.updated_at || 0
  };
}
