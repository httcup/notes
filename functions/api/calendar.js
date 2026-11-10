// /api/calendar  待办的对外出口，一个 token 三种产物
//   GET  ?t=<token>                 公开：日历订阅用的 .ics（VEVENT，日历 App 反复拉取这条）
//   GET  ?t=<token>&format=vtodo    公开：提醒事项用的 .ics（VTODO，Mac 上「文件 → 导入」）
//   GET  ?t=<token>&format=json     公开：快捷指令用的 JSON（todos 数组）
//   GET  （带登录）                  返回自己的订阅地址 / 是否已开启
//   POST {ics,items,count}          更新内容（网页端解析好时间再传上来）
//   POST {reset:true}               换一个订阅地址（旧地址立即失效）
//   POST {off:true}                 关闭订阅，删除订阅源
import { json, preflight, currentUser, randomHex } from '../_lib.js';

const MAX_ICS = 512 * 1024;
const MAX_ITEMS = 2000;

function icsResponse(text, download, name) {
  return new Response(text, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${name || 'ivynote.ics'}"`,
      'cache-control': 'no-store, max-age=0',
      'access-control-allow-origin': '*'
    }
  });
}

const TOMB = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//IvyNote//Reminders//CN\r\nEND:VCALENDAR\r\n';

/* ---------- 由 items 生成提醒事项能导入的 VTODO ---------- */
const pad = (n) => String(n).padStart(2, '0');
function stamp(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T'
    + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}
function icsEsc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r?\n/g, '\\n');
}
function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 73) return line;
  const parts = [];
  let cur = '', len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > 70) { parts.push(cur); cur = ' '; len = 1; }
    cur += ch; len += n;
  }
  parts.push(cur);
  return parts.join('\r\n');
}
const RR = {
  day: 'FREQ=DAILY', weekday: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  week: 'FREQ=WEEKLY', month: 'FREQ=MONTHLY', year: 'FREQ=YEARLY'
};
function vtodoIcs(items) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//IvyNote//Reminders//CN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:待办提醒'
  ];
  const now = stamp(Date.now());
  for (const it of items) {
    if (!it || !it.title) continue;
    lines.push('BEGIN:VTODO');
    lines.push('UID:' + (it.id || randomHex(8)) + '@ivynote');
    lines.push('DTSTAMP:' + now);
    lines.push('SUMMARY:' + icsEsc(it.title));
    if (it.due) lines.push('DUE:' + stamp(it.due));
    lines.push('STATUS:NEEDS-ACTION');
    const desc = [it.note ? '来自笔记：' + it.note : '', it.repeat ? '重复：' + it.repeat : '']
      .filter(Boolean).join(' · ');
    if (desc) lines.push('DESCRIPTION:' + icsEsc(desc));
    if (it.repeat && RR[it.repeat]) lines.push('RRULE:' + RR[it.repeat]);
    lines.push('BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY',
      'DESCRIPTION:' + icsEsc(it.title), 'END:VALARM');
    lines.push('END:VTODO');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

function safeItems(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_ITEMS).map((it) => ({
    id: String((it && it.id) || '').slice(0, 40),
    title: String((it && it.title) || '').slice(0, 300),
    due: Math.max(0, Number((it && it.due) || 0)),
    repeat: String((it && it.repeat) || '').slice(0, 12),
    note: String((it && it.note) || '').slice(0, 200)
  })).filter((it) => it.title);
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);

  const url = new URL(request.url);
  const origin = url.origin;

  try {
    /* ---------- 公开读取：日历 / 提醒事项 / 快捷指令 都走这里 ---------- */
    if (request.method === 'GET' && url.searchParams.has('t')) {
      const token = String(url.searchParams.get('t') || '').slice(0, 80);
      const fmt = String(url.searchParams.get('format') || '').toLowerCase();
      const download = url.searchParams.get('download') === '1';

      const row = await env.DB
        .prepare('SELECT ics, items, count, updated_at FROM calendar_feeds WHERE token = ?1')
        .bind(token)
        .first();
      const items = (() => {
        try { return row ? JSON.parse(row.items || '[]') : []; } catch (e) { return []; }
      })();

      if (fmt === 'json') {
        return json({
          calendar: '待办提醒',
          updatedAt: (row && row.updated_at) || 0,
          count: items.length,
          todos: items
        });
      }
      if (fmt === 'vtodo') {
        return icsResponse(vtodoIcs(items), download, '提醒事项.ics');
      }
      if (!row) return icsResponse(TOMB, false);
      return icsResponse(row.ics || TOMB, download);
    }

    const user = await currentUser(request, env);
    if (!user) return json({ error: '口令不正确或登录已过期' }, 401);
    const uid = user.uid;

    if (request.method === 'GET') {
      const row = await env.DB
        .prepare('SELECT token, count, updated_at FROM calendar_feeds WHERE user_id = ?1')
        .bind(uid)
        .first();
      if (!row) return json({ on: false, token: '', count: 0, updatedAt: 0 });
      const link = `${origin}/api/calendar?t=${row.token}`;
      return json({
        on: true,
        token: row.token,
        url: link,
        webcal: link.replace(/^https?:\/\//, 'webcal://'),
        count: row.count || 0,
        updatedAt: row.updated_at || 0
      });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const now = Date.now();

      if (body.off) {
        await env.DB.prepare('DELETE FROM calendar_feeds WHERE user_id = ?1').bind(uid).run();
        return json({ on: false, token: '' });
      }

      const ics = typeof body.ics === 'string' ? body.ics.slice(0, MAX_ICS) : '';
      const items = safeItems(body.items);
      const itemsJson = JSON.stringify(items).slice(0, MAX_ICS);
      const count = Math.max(0, Math.min(9999, Number(body.count) || items.length));
      const exist = await env.DB
        .prepare('SELECT token FROM calendar_feeds WHERE user_id = ?1')
        .bind(uid)
        .first();

      // 换地址才换 token；平时只更新内容，别把已经订阅到日历里的链接弄失效
      const token = exist && !body.reset ? exist.token : randomHex(20);

      if (exist) {
        await env.DB
          .prepare(`UPDATE calendar_feeds SET token = ?2, ics = ?3, items = ?4, count = ?5, updated_at = ?6
                    WHERE user_id = ?1`)
          .bind(uid, token, ics, itemsJson, count, now)
          .run();
      } else {
        await env.DB
          .prepare(
            `INSERT INTO calendar_feeds (token, user_id, ics, items, count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
          )
          .bind(token, uid, ics, itemsJson, count, now, now)
          .run();
      }

      const link = `${origin}/api/calendar?t=${token}`;
      return json({
        on: true,
        token,
        url: link,
        webcal: link.replace(/^https?:\/\//, 'webcal://'),
        count,
        updatedAt: now
      });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
