// /api/calevents  苹果日历的事件镜像（网页端日历视图的数据源）
//
// 浏览器读不到 macOS / iOS 的日历，所以由 Mac 端脚本（tools/apple-calendar-sync.py）
// 用系统授权读一遍，把事件推上来；前端只读这份快照。
//
//   GET  ?from=<ms>&to=<ms>    带登录：返回时间窗内的事件（不传 from/to 默认前后各 90 天）
//   GET  ?meta=1               带登录：返回各日历的事件数与最后同步时间（给「上次同步于」用）
//   POST { events:[...], full:true }
//                              带登录：批量 upsert。full=true 表示这次是全量，
//                              时间窗内没再出现的事件会被删掉（苹果那边删了，这边也跟着删）
//   POST { clear:true }        带登录：清空自己的日历镜像
//
// 事件的 uid 由苹果日历提供，跨设备稳定；同一 uid 再推一次就是更新，不会重复。
import { json, preflight, currentUser } from '../_lib.js';

const MAX_EVENTS = 5000;
const DAY = 86400000;

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/* 颜色只收 #rgb / #rrggbb，别把任意字符串塞进 CSS */
function safeColor(v) {
  const s = String(v || '').trim();
  return /^#([\da-f]{3}|[\da-f]{6})$/i.test(s) ? s : '';
}

function normEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const uid = str(e.uid, 120).trim();
  const title = str(e.title, 300).trim();
  if (!uid || !title) return null;
  const start = num(e.start);
  if (!start) return null;
  return {
    uid,
    cal: str(e.cal, 80).slice(0, 80),
    color: safeColor(e.color),
    title,
    start,
    end: Math.max(start, num(e.end, start)),
    allDay: e.allDay ? 1 : 0,
    location: str(e.location, 300),
    notes: str(e.notes, 2000),
    updatedAt: num(e.updatedAt) || Date.now()
  };
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);

  const url = new URL(request.url);

  try {
    const user = await currentUser(request, env);
    if (!user) return json({ error: '口令不正确或登录已过期' }, 401);
    const uid = user.uid;

    /* ---------- 读 ---------- */
    if (request.method === 'GET') {
      if (url.searchParams.get('meta') === '1') {
        const rows = await env.DB
          .prepare(`SELECT cal, COUNT(*) AS n, MAX(updated_at) AS last
                    FROM calendar_events WHERE user_id = ?1 GROUP BY cal ORDER BY n DESC`)
          .bind(uid)
          .all();
        const list = (rows.results || []).map((r) => ({
          cal: r.cal || '未命名日历',
          count: Number(r.n) || 0,
          last: Number(r.last) || 0
        }));
        const total = list.reduce((s, x) => s + x.count, 0);
        const last = list.reduce((s, x) => Math.max(s, x.last), 0);
        return json({ ok: true, total, last, calendars: list });
      }

      const now = Date.now();
      const from = num(url.searchParams.get('from'), now - 90 * DAY);
      const to = num(url.searchParams.get('to'), now + 90 * DAY);
      const res = await env.DB
        .prepare(`SELECT uid, cal, color, title, start, end, all_day, location, notes, updated_at
                  FROM calendar_events
                  WHERE user_id = ?1 AND start < ?3 AND end >= ?2
                  ORDER BY start ASC LIMIT ${MAX_EVENTS}`)
        .bind(uid, from, to)
        .all();
      const events = (res.results || []).map((r) => ({
        uid: r.uid,
        cal: r.cal || '',
        color: r.color || '',
        title: r.title || '',
        start: Number(r.start) || 0,
        end: Number(r.end) || 0,
        allDay: !!r.all_day,
        location: r.location || '',
        notes: r.notes || '',
        updatedAt: Number(r.updated_at) || 0
      }));
      return json({ ok: true, from, to, count: events.length, events });
    }

    /* ---------- 写 ---------- */
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));

      if (body.clear) {
        await env.DB.prepare('DELETE FROM calendar_events WHERE user_id = ?1').bind(uid).run();
        return json({ ok: true, cleared: true });
      }

      const raw = Array.isArray(body.events) ? body.events : [];
      const events = raw.slice(0, MAX_EVENTS).map(normEvent).filter(Boolean);
      if (!events.length && !body.full) return json({ error: '没有有效事件' }, 400);

      const stmts = events.map((e) =>
        env.DB
          .prepare(`INSERT INTO calendar_events
                      (user_id, uid, cal, color, title, start, end, all_day, location, notes, updated_at)
                    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                    ON CONFLICT(user_id, uid) DO UPDATE SET
                      cal=excluded.cal, color=excluded.color, title=excluded.title,
                      start=excluded.start, end=excluded.end, all_day=excluded.all_day,
                      location=excluded.location, notes=excluded.notes, updated_at=excluded.updated_at`)
          .bind(uid, e.uid, e.cal, e.color, e.title, e.start, e.end, e.allDay,
                e.location, e.notes, e.updatedAt)
      );

      // D1 单次 batch 有上限，分批提交
      for (let i = 0; i < stmts.length; i += 40) {
        await env.DB.batch(stmts.slice(i, i + 40));
      }

      // full=true：这次是全量镜像，窗口内没再出现的事件说明苹果那边删了。
      // 先在内存里求差集，再分批删 —— 直接把几千个 uid 拼进 NOT IN 会撞 SQL 变量上限。
      let removed = 0;
      if (body.full) {
        const from = num(body.from, Date.now() - 400 * DAY);
        const to = num(body.to, Date.now() + 400 * DAY);
        const exist = await env.DB
          .prepare(`SELECT uid FROM calendar_events
                    WHERE user_id = ?1 AND start < ?3 AND end >= ?2`)
          .bind(uid, from, to)
          .all();
        const keep = new Set(events.map((e) => e.uid));
        const gone = (exist.results || []).map((r) => r.uid).filter((u) => !keep.has(u));
        for (let i = 0; i < gone.length; i += 50) {
          const chunk = gone.slice(i, i + 50);
          await env.DB
            .prepare(`DELETE FROM calendar_events
                      WHERE user_id = ?1 AND uid IN (${chunk.map((_, k) => '?' + (k + 2)).join(',')})`)
            .bind(uid, ...chunk)
            .run();
        }
        removed = gone.length;
      }

      const total = await env.DB
        .prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?1')
        .bind(uid)
        .first();
      return json({ ok: true, saved: events.length, removed, total: Number(total && total.n) || 0 });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
