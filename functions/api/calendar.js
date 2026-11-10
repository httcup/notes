// /api/calendar  日历订阅源
//   GET  ?t=<token>            公开：返回该订阅源的 .ics（日历 App 反复拉取这条）
//   GET  （带登录）             返回自己的订阅地址 / 是否已开启
//   POST {ics,count}            更新订阅内容（网页端解析好时间再传上来）
//   POST {reset:true}           换一个订阅地址（旧地址立即失效）
//   POST {off:true}             关闭订阅，删除订阅源
import { json, preflight, currentUser, randomHex } from '../_lib.js';

const MAX_ICS = 512 * 1024;

function icsResponse(text, download) {
  return new Response(text, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="ivynote.ics"`,
      'cache-control': 'no-store, max-age=0',
      'access-control-allow-origin': '*'
    }
  });
}

const TOMB = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//IvyNote//Reminders//CN\r\nEND:VCALENDAR\r\n';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);

  const url = new URL(request.url);
  const origin = url.origin;

  try {
    /* ---------- 公开读取：日历 App 就是靠这条 ---------- */
    if (request.method === 'GET' && url.searchParams.has('t')) {
      const token = String(url.searchParams.get('t') || '').slice(0, 80);
      const row = await env.DB
        .prepare('SELECT ics FROM calendar_feeds WHERE token = ?1')
        .bind(token)
        .first();
      if (!row) return icsResponse(TOMB, false);
      return icsResponse(row.ics || TOMB, url.searchParams.get('download') === '1');
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
      const count = Math.max(0, Math.min(9999, Number(body.count) || 0));
      const exist = await env.DB
        .prepare('SELECT token FROM calendar_feeds WHERE user_id = ?1')
        .bind(uid)
        .first();

      // 换地址才换 token；平时只更新内容，别把已经订阅到日历里的链接弄失效
      let token = exist && !body.reset ? exist.token : randomHex(20);

      if (exist) {
        await env.DB
          .prepare('UPDATE calendar_feeds SET token = ?2, ics = ?3, count = ?4, updated_at = ?5 WHERE user_id = ?1')
          .bind(uid, token, ics, count, now)
          .run();
      } else {
        await env.DB
          .prepare(
            `INSERT INTO calendar_feeds (token, user_id, ics, count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
          )
          .bind(token, uid, ics, count, now, now)
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
