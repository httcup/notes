// functions/_caldav.js
// iCloud CalDAV 客户端（跑在 Cloudflare Workers 上）
//
// 注意几个 Workers 环境的限制：
//   - 没有 DOMParser，所以 XML 全部用正则取；
//   - 没有 btoa 之外的二进制工具，Basic 认证直接用 btoa；
//   - fetch 可以发 PROPFIND / REPORT，Apple 接受。
// iCloud 的流程：caldav.icloud.com → current-user-principal → calendar-home-set → 各日历。

const UA = 'IvyNote/1.0 (macOS)';

export const BASE = 'https://caldav.icloud.com/';

export function basicAuth(user, pass) {
  // 不用 unescape/encodeURIComponent：Workers 里对遗留函数支持不稳，直接按 UTF-8 字节转
  const bytes = new TextEncoder().encode(user + ':' + pass);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'Basic ' + btoa(bin);
}

/* ---------------- XML 小工具（够用就好） ---------------- */
export function xmlBlocks(xml, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

export function xmlText(xml, tag) {
  const b = xmlBlocks(xml, tag)[0];
  return b == null ? '' : unxml(b.replace(/<[^>]*>/g, '')).trim();
}

export function unxml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

export function xesc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* iCloud 会把账号分配到分区主机（p55-caldav.icloud.com 这种），
   href 常常是相对路径，必须基于当前所在的 base 解析，不能一律拼主域名 */
export function absUrl(href, base) {
  if (!href) return '';
  try {
    return new URL(href, base || BASE).toString();
  } catch (e) {
    return href;
  }
}

/* ---------------- 底层请求 ---------------- */
async function dav(url, { method = 'GET', auth, body, depth, extra } = {}) {
  const headers = {
    'user-agent': UA,
    authorization: auth
  };
  if (depth != null) headers.depth = String(depth);
  if (body) headers['content-type'] = 'application/xml; charset=utf-8';
  if (extra) Object.assign(headers, extra);
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  // res.url 是跟随重定向后的真实地址：iCloud 会把账号甩到 p55-caldav 这种分区主机，
  // 后续所有相对 href 都必须基于它解析，否则请求打到主域名上会拿到空列表
  return { status: res.status, ok: res.ok, text, headers: res.headers, url: res.url || url };
}

/* ---------------- 1. 发现 principal ---------------- */
const PF_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

export async function discoverPrincipal(auth) {
  const r = await dav(BASE, { method: 'PROPFIND', auth, depth: 0, body: PF_PRINCIPAL });
  // iCloud 对错误凭据给 403（有时 401），都算认证失败
  if (r.status === 401 || r.status === 403) return { error: 'auth' };
  if (!r.ok) return { error: 'http' + r.status, detail: r.text.slice(0, 200) };
  const block = xmlBlocks(r.text, 'current-user-principal')[0] || '';
  const inner = /<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/i.exec(block);
  const principal = absUrl(inner ? unxml(inner[1]).trim() : '', r.url);
  if (!principal) return { error: 'no-principal', detail: r.text.slice(0, 300) };
  return { principal };
}

/* ---------------- 2. 发现 calendar-home ---------------- */
const PF_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop></d:propfind>`;

export async function discoverHome(auth, principal) {
  const r = await dav(principal, { method: 'PROPFIND', auth, depth: 0, body: PF_HOME });
  if (!r.ok) return { error: 'http' + r.status, detail: r.text.slice(0, 200) };
  const block = xmlBlocks(r.text, 'calendar-home-set')[0] || '';
  const inner = /<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/i.exec(block);
  const home = absUrl(inner ? unxml(inner[1]).trim() : '', r.url);
  if (!home) return { error: 'no-home', detail: r.text.slice(0, 300) };
  return { home };
}

/* ---------------- 3. 列日历 ---------------- */
const PF_CALS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <c:supported-calendar-component-set/>
    <cs:calendar-color/>
  </d:prop>
</d:propfind>`;

export async function listCalendars(auth, home) {
  const r = await dav(home, { method: 'PROPFIND', auth, depth: 1, body: PF_CALS });
  if (!r.ok) return { error: 'http' + r.status, detail: r.text.slice(0, 300) };

  const items = [];
  for (const block of xmlBlocks(r.text, 'response')) {
    const hrefM = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i.exec(block);
    const href = absUrl(unxml((hrefM ? hrefM[1] : '').trim()), home);
    if (!href) continue;
    const comps = [...block.matchAll(/<(?:[\w.-]+:)?comp\b[^>]*name="([^"]+)"/gi)].map((m) => m[1].toUpperCase());
    const name = xmlText(block, 'displayname') || decodeURIComponent(href.split('/').filter(Boolean).pop() || '');
    const color = xmlText(block, 'calendar-color') || '';
    items.push({
      href, name, comps,
      // 关键是这里：iCloud 给的是 <calendar xmlns="urn:ietf:params:xml:ns:caldav"/>，
      // 带属性的写法，只认 <calendar/> 会把日历全过滤掉
      isCal: /<(?:[\w.-]+:)?calendar(?:\s[^>]*)?\/?>/i.test(block),
      color: /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7) : ''
    });
  }

  const norm = (it) => ({ href: it.href, name: (it.name || '日历').slice(0, 80), color: it.color });
  // 先按 resourcetype 挑；挑不出来（不同服务器写法不一致）就退一步：
  // 凡是带名字、又不是 home 本身的集合都当日历，宁可多列也别空着
  let picked = items.filter((it) => it.isCal && (!it.comps.length || it.comps.includes('VEVENT')));
  if (!picked.length) {
    picked = items.filter((it) => it.name && it.href.replace(/\/$/, '') !== String(home).replace(/\/$/, ''));
  }
  return { calendars: picked.map(norm), raw: r.text };
}

/* ---------------- 4. 拉事件 ---------------- */
function utcBasic(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + 'T'
    + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
}

export function reportQuery(fromMs, toMs) {
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${utcBasic(fromMs)}" end="${utcBasic(toMs)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
}

export async function fetchCalendar(auth, calHref, fromMs, toMs) {
  const r = await dav(calHref, { method: 'REPORT', auth, depth: 1, body: reportQuery(fromMs, toMs) });
  if (!r.ok) return { error: 'http' + r.status, detail: r.text.slice(0, 200) };
  const out = [];
  for (const block of xmlBlocks(r.text, 'response')) {
    const hrefM = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i.exec(block);
    const href = absUrl(unxml((hrefM ? hrefM[1] : '').trim()), calHref);
    const etag = xmlText(block, 'getetag').replace(/^W\//, '').replace(/"/g, '');
    const dataM = /<(?:[\w.-]+:)?calendar-data\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?calendar-data>/i.exec(block);
    if (!dataM) continue;
    const ics = unxml(dataM[1]);
    const ev = parseEvent(ics);
    if (ev) out.push({ href, etag, ics, ...ev });
  }
  return { events: out };
}

/* ---------------- 5. iCalendar 解析 ---------------- */
export function tzOffsetMin(tzid, approxUtcMs) {
  if (!tzid) return 480;                     // 浮动时间按 +08:00（自己用，基本都在国内）
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, timeZoneName: 'longOffset'
    }).formatToParts(new Date(approxUtcMs));
    const tz = (parts.find((p) => p.type === 'timeZoneName') || {}).value || '';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tz);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch (e) {
    return 480;
  }
}

function parseIcsDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value || '').trim());
  if (!m) return null;
  const [, Y, M, D, h, mi, s, Z] = m;
  const allDay = h == null;
  if (allDay) return { ts: Date.UTC(+Y, +M - 1, +D), allDay: true };
  const naive = Date.UTC(+Y, +M - 1, +D, +h, +mi, +s);
  if (Z) return { ts: naive, allDay: false };
  const tzid = params && params.TZID;
  const off = tzOffsetMin(tzid, naive);
  return { ts: naive - off * 60000, allDay: false };
}

function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const left = line.slice(0, i);
  const value = line.slice(i + 1);
  const segs = left.split(';');
  const params = {};
  for (let k = 1; k < segs.length; k++) {
    const eq = segs[k].indexOf('=');
    const key = (eq > 0 ? segs[k].slice(0, eq) : segs[k]).toUpperCase();
    let v = eq > 0 ? segs[k].slice(eq + 1) : '';
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[key] = v;
  }
  return { name: segs[0].toUpperCase(), params, value };
}

function icsUnescape(s) {
  return String(s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/* 只取第一个 VEVENT，够用来做日历展示和编辑 */
export function parseEvent(ics) {
  if (!ics) return null;
  const text = String(ics).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').replace(/\r/g, '');
  const lines = text.split('\n');
  let inEvent = false;
  const props = {};
  for (const ln of lines) {
    if (/^BEGIN:VEVENT/i.test(ln)) { inEvent = true; continue; }
    if (/^END:VEVENT/i.test(ln)) break;
    if (!inEvent) continue;
    const p = parseLine(ln);
    if (!p) continue;
    props[p.name] = p;   // 同名属性只留最后一个（足够）
  }
  if (!props.UID || !props.DTSTART) return null;
  const st = parseIcsDate(props.DTSTART.value, props.DTSTART.params);
  if (!st) return null;
  const en = props.DTEND ? parseIcsDate(props.DTEND.value, props.DTEND.params) : null;
  const dur = props.DURATION ? props.DURATION.value : '';
  let end = en ? en.ts : st.ts;
  if (!en && dur) {
    const dm = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i.exec(dur);
    if (dm) end = st.ts + ((+dm[1] || 0) * 86400000) + ((+dm[2] || 0) * 3600000) + ((+dm[3] || 0) * 60000);
  }
  return {
    uid: props.UID.value,
    title: icsUnescape(props.SUMMARY ? props.SUMMARY.value : ''),
    start: st.ts,
    end: Math.max(st.ts, end),
    allDay: st.allDay,
    location: icsUnescape(props.LOCATION ? props.LOCATION.value : ''),
    notes: icsUnescape(props.DESCRIPTION ? props.DESCRIPTION.value : '').slice(0, 4000),
    rrule: props.RRULE ? props.RRULE.value : ''
  };
}

/* ---------------- 6. 写回 iCloud ---------------- */
function icsEsc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsFold(line) {
  // iCalendar 单行 75 字节折行，中文按 UTF-8 字节算
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 73) return line;
  const out = [];
  let cur = '', len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > 70) { out.push(cur); cur = ' '; len = 1; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

function dateOnly(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}

export function buildIcs(ev) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//IvyNote//Calendar//CN',
    'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    'UID:' + (ev.uid || (Date.now().toString(36) + '@ivynote')),
    'DTSTAMP:' + utcBasic(Date.now())
  ];
  if (ev.allDay) {
    lines.push('DTSTART;VALUE=DATE:' + dateOnly(ev.start));
    lines.push('DTEND;VALUE=DATE:' + dateOnly(ev.end || ev.start + 86400000));
  } else {
    lines.push('DTSTART:' + utcBasic(ev.start));
    lines.push('DTEND:' + utcBasic(Math.max(ev.start + 60000, ev.end || ev.start + 3600000)));
  }
  lines.push('SUMMARY:' + icsEsc(ev.title || ''));
  if (ev.location) lines.push('LOCATION:' + icsEsc(ev.location));
  if (ev.notes) lines.push('DESCRIPTION:' + icsEsc(ev.notes));
  if (ev.rrule) lines.push('RRULE:' + ev.rrule);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

export async function putEvent(auth, href, ics, etag) {
  const extra = { 'content-type': 'text/calendar; charset=utf-8' };
  if (etag) extra['if-match'] = etag;
  else extra['if-none-match'] = '*';
  const r = await dav(href, { method: 'PUT', auth, body: ics, extra });
  if (r.status === 412) return { error: 'conflict' };
  if (!r.ok) return { error: 'http' + r.status, detail: r.text.slice(0, 200) };
  return { ok: true, href, etag: (r.headers.get('etag') || '').replace(/^W\//, '').replace(/"/g, '') };
}

export async function deleteEvent(auth, href, etag) {
  const extra = {};
  if (etag) extra['if-match'] = etag;
  const r = await dav(href, { method: 'DELETE', auth, extra });
  if (r.status === 412) return { error: 'conflict' };
  if (!r.ok && r.status !== 404) return { error: 'http' + r.status, detail: r.text.slice(0, 200) };
  return { ok: true };
}

/* 一次把「连接 → 发现 → 列日历」跑完，给「测试连接」用 */
export async function probe(appleId, appPassword) {
  const auth = basicAuth(appleId, appPassword);
  const p = await discoverPrincipal(auth);
  if (p.error) return { error: p.error === 'auth' ? 'auth' : p.error, detail: p.detail };
  const h = await discoverHome(auth, p.principal);
  if (h.error) return { error: h.error, detail: h.detail };
  const c = await listCalendars(auth, h.home);
  if (c.error) return { error: c.error, detail: c.detail };
  // 一个日历都没有时，把原始响应留一份给前端看，方便定位（只截前 1200 字）
  return {
    auth, principal: p.principal, home: h.home, calendars: c.calendars,
    raw: c.calendars.length ? '' : String(c.raw || '').slice(0, 1200)
  };
}
