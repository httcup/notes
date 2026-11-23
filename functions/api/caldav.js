// /api/caldav  iCloud 日历双向同步（CalDAV）
//
//   GET                       查状态：连没连、Apple ID（打码）、可选的日历、上次同步
//   POST {action:'connect'}   用 Apple ID + App 专用密码连一次，验证后加密保存
//   POST {action:'disconnect'}删除凭据
//   POST {action:'toggle'}    开/关某个日历（{href, on}）
//   POST {action:'sync'}      拉取所选日历在时间窗内的事件，覆盖写入 calendar_events
//   POST {action:'save'}      新建或修改一条事件，写回 iCloud
//   POST {action:'remove'}    删除一条事件（{href, etag}）
//
// 凭据：App 专用密码用「IVY_SECRET 派生出的 AES-GCM key」加密后才落库，永不回传前端。
import { json, preflight, currentUser } from '../_lib.js';
import * as DAV from '../_caldav.js';

const SALT = 'ivy-caldav-v1';
const DAY = 86400000;

/* ---------------- 凭据加解密 ---------------- */
function b64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
async function cryptoKey(secretText) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(secretText), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(SALT), iterations: 100000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
async function seal(secretText, plain) {
  const k = await cryptoKey(secretText);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plain));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return b64(out);
}
async function unseal(secretText, sealed) {
  const raw = unb64(sealed);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const k = await cryptoKey(secretText);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct);
  return new TextDecoder().decode(pt);
}

function maskId(id) {
  const s = String(id || '');
  const at = s.indexOf('@');
  if (at <= 2) return s;
  return s.slice(0, 2) + '***' + s.slice(at);
}

/* 同一件事在不同日历里的 uid 可能一样，拼上日历路径才唯一 */
function rowUid(calHref, uid) {
  return String(calHref).replace(/\/$/, '').split('/').pop() + '::' + uid;
}

/* 笔记待办镜像成的事件：文件名固定为 ivy-todo-<key>.ics，
   所以不用记 href/etag，key 就够定位、覆盖、删除 */
const TODO_FILE_RE = /\/ivy-todo-([0-9a-f]{4,32})\.ics$/i;

async function pushTodos(auth, calHref, todos, kept) {
  const base = String(calHref).replace(/\/$/, '');
  const want = new Map();
  for (const t of (Array.isArray(todos) ? todos : []).slice(0, 400)) {
    const k = String(t.key || '').toLowerCase();
    if (!/^[0-9a-f]{4,32}$/.test(k)) continue;
    const title = String(t.title || '').trim().slice(0, 300);
    const start = Number(t.start) || 0;
    if (!title || !start) continue;
    want.set(k, { title, start, end: Number(t.end) || start + DAY, allDay: !!t.allDay });
  }
  const jobs = [];
  let pushed = 0;
  let removed = 0;
  for (const [k, t] of want) {
    const old = kept.get(k);
    if (old && old.title === t.title && Number(old.start) === Number(t.start) && !!old.allDay === t.allDay) continue;
    const href = base + '/ivy-todo-' + k + '.ics';
    jobs.push(() => DAV.putEventForce(auth, href, DAV.buildIcs({
      uid: 'ivy-todo-' + k + '@ivynote', title: t.title, start: t.start, end: t.end, allDay: t.allDay
    })).then((r) => { if (r.ok) pushed++; }));
  }
  for (const [k, old] of kept) {
    if (want.has(k)) continue;                 // 笔记里删了 / 做完了 → 苹果日历里也撤掉
    jobs.push(() => DAV.deleteEvent(auth, old.href, '').then((r) => { if (r.ok) removed++; }));
  }
  // iCloud 单次 PUT 可能要好几秒，4 条并发跑，别串成一长串
  for (let i = 0; i < jobs.length; i += 4) {
    await Promise.all(jobs.slice(i, i + 4).map((f) => f().catch(() => {})));
  }
  return { pushed, removed, total: want.size };
}

async function getRow(env, uid) {
  return env.DB.prepare('SELECT * FROM caldav_config WHERE user_id = ?1').bind(uid).first();
}

async function loadAuth(env, row) {
  const pass = await unseal(env.IVY_SECRET, row.secret);
  return DAV.basicAuth(row.apple_id, pass);
}

function calList(row) {
  try { return JSON.parse(row.calendars || '[]'); } catch (e) { return []; }
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);
  if (!env.IVY_SECRET) return json({ error: '服务端未配置 IVY_SECRET，无法加密保存凭据' }, 503);

  const user = await currentUser(request, env);
  if (!user) return json({ error: '口令不正确或登录已过期' }, 401);
  const uid = user.uid;

  try {
    /* ---------------- 读状态 ---------------- */
    if (request.method === 'GET') {
      const row = await getRow(env, uid);
      if (!row) return json({ ok: true, connected: false });
      const cnt = await env.DB
        .prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?1 AND href IS NOT NULL")
        .bind(uid).first();
      return json({
        ok: true,
        connected: true,
        appleId: maskId(row.apple_id),
        // 重新连接时用来预填输入框（只回给自己这个账号）
        appleIdRaw: row.apple_id,
        home: row.home || '',
        calendars: calList(row),
        lastSync: Number(row.last_sync) || 0,
        synced: Number(cnt && cnt.n) || 0
      });
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '');

    /* ---------------- 连接 ---------------- */
    if (action === 'connect') {
      const appleId = String(body.appleId || '').trim().slice(0, 120);
      const pass = String(body.appPassword || '').replace(/[\s-]/g, '');
      if (!appleId || !pass) return json({ error: '填一下 Apple ID 和 App 专用密码' }, 400);
      if (pass.length < 8) return json({ error: 'App 专用密码是 16 位字母，中间可以有横线' }, 400);

      const p = await DAV.probe(appleId, pass);
      if (p.error === 'auth') return json({ error: 'Apple ID 或 App 专用密码不对（密码要去 appleid.apple.com 生成，不是登录密码）' }, 400);
      if (p.error) return json({ error: '连不上 iCloud：' + p.error, detail: p.detail || '' }, 502);
      if (!p.calendars.length) {
        return json({
          error: '这个账号下没找到可写的日历',
          debug: 'home=' + p.home + '\n\n' + (p.raw || '')
        }, 400);
      }

      const sealed = await seal(env.IVY_SECRET, pass);
      const now = Date.now();
      const existing = calList(await getRow(env, uid)).reduce((m, c) => (m[c.href] = c.on !== false, m), {});
      // 已经关掉的日历，重连后保持关掉
      const cals = p.calendars.map((c) => ({ ...c, on: existing[c.href] !== false }));

      const had = await getRow(env, uid);
      if (had) {
        await env.DB.prepare(`UPDATE caldav_config SET apple_id=?2, secret=?3, principal=?4, home=?5,
            calendars=?6, updated_at=?7 WHERE user_id=?1`)
          .bind(uid, appleId, sealed, p.principal, p.home, JSON.stringify(cals), now).run();
      } else {
        await env.DB.prepare(`INSERT INTO caldav_config
            (user_id, apple_id, secret, principal, home, calendars, last_sync, created_at, updated_at)
            VALUES (?1,?2,?3,?4,?5,?6,0,?7,?7)`)
          .bind(uid, appleId, sealed, p.principal, p.home, JSON.stringify(cals), now).run();
      }
      return json({ ok: true, connected: true, appleId: maskId(appleId), calendars: cals });
    }

    /* ---------------- 断开 ---------------- */
    if (action === 'disconnect') {
      await env.DB.prepare('DELETE FROM caldav_config WHERE user_id = ?1').bind(uid).run();
      // 同步来的事件也一起清掉，避免留下再也写不回去的孤儿
      await env.DB.prepare('DELETE FROM calendar_events WHERE user_id = ?1 AND href IS NOT NULL').bind(uid).run();
      return json({ ok: true, connected: false });
    }

    const row = await getRow(env, uid);
    if (!row) return json({ error: '还没连接苹果日历' }, 400);

    /* ---------------- 开关日历 ---------------- */
    if (action === 'toggle') {
      const href = String(body.href || '');
      const cals = calList(row);
      const hit = cals.find((c) => c.href === href);
      if (!hit) return json({ error: '没有这个日历' }, 404);
      hit.on = body.on !== false;
      await env.DB.prepare('UPDATE caldav_config SET calendars=?2, updated_at=?3 WHERE user_id=?1')
        .bind(uid, JSON.stringify(cals), Date.now()).run();
      return json({ ok: true, calendars: cals });
    }

    const auth = await loadAuth(env, row);

    /* ---------------- 同步（拉取） ---------------- */
    if (action === 'sync') {
      const from = Number(body.from) || (Date.now() - 180 * DAY);
      const to = Number(body.to) || (Date.now() + 180 * DAY);

      // 每次同步顺手刷新日历清单：苹果那边新建/删除/改名日历，这里不用重连就能跟上。
      // 开关状态按 href 保留，新出现的日历默认打开。
      try {
        const fresh = await DAV.listCalendars(auth, row.home);
        if (fresh.calendars && fresh.calendars.length) {
          const prevOn = calList(row).reduce((m, c) => { m[c.href] = c.on !== false; return m; }, {});
          const merged = fresh.calendars.map((c) => ({ ...c, on: prevOn[c.href] !== false }));
          const next = JSON.stringify(merged);
          if (next !== String(row.calendars || '')) {
            await env.DB.prepare('UPDATE caldav_config SET calendars=?2, updated_at=?3 WHERE user_id=?1')
              .bind(uid, next, Date.now()).run();
            row.calendars = next;
          }
        }
      } catch (e) { /* 刷新失败不影响本次拉取 */ }

      const cals = calList(row).filter((c) => c.on !== false);
      if (!cals.length) return json({ error: '没有打开任何日历' }, 400);

      const errors = [];
      const okCals = [];
      const per = [];
      const collected = [];
      const seen = new Set();
      const keptTodo = new Map();     // 笔记待办推上去的事件：key -> {href,title,start,allDay}
      let authBad = false;
      for (const c of cals) {
        const r = await DAV.fetchCalendar(auth, c.href, from, to);
        if (r.error) {
          // 401/403 说明凭据已经不能用了（改过 Apple ID 密码、撤销过 App 专用密码），
          // 这不是「这个日历没权限」，得让用户重连，不能静默当成空日历
          if (r.error === 'http401' || r.error === 'http403') authBad = true;
          errors.push(c.name + ': ' + r.error);
          continue;
        }
        okCals.push(c.name);
        per.push(c.name + ' ' + r.events.length);
        for (const ev of r.events) {
          // 笔记待办镜像出来的事件（文件名 ivy-todo-<key>.ics）不进库，
          // 日历上那一条由前端直接用笔记内容画，避免同一件事出现两次
          const tm = /\/ivy-todo-([0-9a-f]{4,32})\.ics$/i.exec(ev.href || '');
          if (tm) {
            keptTodo.set(tm[1].toLowerCase(), { href: ev.href, title: ev.title, start: ev.start, allDay: !!ev.allDay });
            continue;
          }
          // 重复事件（RRULE）服务器只给主事件，这里保留第一条实例，避免同一 UID 反复覆盖
          const k = c.href + '|' + ev.uid;
          if (seen.has(k)) continue;
          seen.add(k);
          collected.push({ ...ev, cal: c.name, color: c.color || '' });
        }
      }

      // 一条都没拉到就别动库：以前这里无条件 DELETE，密码一失效就把整个日历清空了
      if (!okCals.length) {
        return json({
          error: authBad
            ? 'iCloud 拒绝了登录，App 专用密码可能已失效（改过 Apple ID 密码或撤销过就会失效）'
            : '所有日历都没拉到数据',
          authBad, errors
        }, authBad ? 401 : 502);
      }

      // 窗口内的旧数据换掉：只清拉取成功的那些日历，
      // 失败的日历保持原样，免得某次网络抖动把整月事件抹掉
      const inList = okCals.map((_, k) => '?' + (k + 4)).join(',');
      await env.DB
        .prepare(`DELETE FROM calendar_events WHERE user_id = ?1 AND start < ?3 AND end >= ?2 AND cal IN (${inList})`)
        .bind(uid, from, to, ...okCals).run();

      // 苹果那边删掉或改了名的日历，本地还留着它的旧事件 —— 顺手清掉。
      // 名字不在当前日历列表里的一律算过期（NULL/空串是早期脚本留下的，也一并清）
      const known = calList(row).map((c) => c.name).filter(Boolean);
      if (known.length) {
        const notIn = known.map((_, k) => '?' + (k + 4)).join(',');
        await env.DB
          .prepare(`DELETE FROM calendar_events WHERE user_id = ?1 AND start < ?3 AND end >= ?2
                    AND (cal IS NULL OR cal = '' OR cal NOT IN (${notIn}))`)
          .bind(uid, from, to, ...known).run();
      }

      const stmts = collected.map((e) => {
        const key = rowUid(e.href.split('/').slice(0, -1).join('/'), e.uid);
        return env.DB.prepare(`INSERT INTO calendar_events
            (user_id, uid, cal, color, title, start, end, all_day, location, notes, updated_at, href, etag)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
            ON CONFLICT(user_id, uid) DO UPDATE SET
              cal=excluded.cal, color=excluded.color, title=excluded.title, start=excluded.start,
              end=excluded.end, all_day=excluded.all_day, location=excluded.location,
              notes=excluded.notes, updated_at=excluded.updated_at, href=excluded.href, etag=excluded.etag`)
          .bind(uid, key, e.cal, e.color, e.title, e.start, e.end, e.allDay ? 1 : 0,
                e.location, e.notes, Date.now(), e.href, e.etag || '');
      });
      for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));

      await env.DB.prepare('UPDATE caldav_config SET last_sync=?2, updated_at=?2 WHERE user_id=?1')
        .bind(uid, Date.now()).run();

      // 笔记里带日期的待办，顺手写成苹果日历里的事件（单向：笔记 → 苹果）
      let todo = { pushed: 0, removed: 0 };
      if (Array.isArray(body.todos)) {
        const target = cals.find((c) => okCals.includes(c.name)) || cals[0];
        try {
          todo = await pushTodos(auth, target.href, body.todos, keptTodo);
        } catch (e) { /* 待办推送失败不影响事件同步 */ }
      }

      return json({ ok: true, pulled: collected.length, per, errors, authBad, todo, lastSync: Date.now() });
    }

    /* ---------------- 只推待办（笔记一改就调，不拉全天事件） ---------------- */
    if (action === 'pushtodos') {
      const cals = calList(row).filter((c) => c.on !== false);
      if (!cals.length) return json({ error: '没有打开任何日历' }, 400);
      const target = cals[0];
      const now = Date.now();
      const r = await DAV.fetchCalendar(auth, target.href, now - 730 * DAY, now + 730 * DAY);
      if (r.error === 'http401' || r.error === 'http403') return json({ error: 'iCloud 登录失效', authBad: true }, 401);
      if (r.error) return json({ error: '拉取失败：' + r.error }, 502);
      const kept = new Map();
      for (const ev of r.events) {
        const tm = TODO_FILE_RE.exec(ev.href || '');
        if (tm) kept.set(tm[1].toLowerCase(), { href: ev.href, title: ev.title, start: ev.start, allDay: !!ev.allDay });
      }
      const out = await pushTodos(auth, target.href, Array.isArray(body.todos) ? body.todos : [], kept);
      return json({ ok: true, ...out });
    }

    /* ---------------- 写回：新建 / 修改 ---------------- */
    if (action === 'save') {
      const ev = body.event || {};
      const title = String(ev.title || '').trim().slice(0, 300);
      const start = Number(ev.start) || 0;
      if (!title) return json({ error: '标题不能为空' }, 400);
      if (!start) return json({ error: '缺开始时间' }, 400);

      let calHref = String(ev.calHref || '');
      if (!calHref) {
        const first = calList(row).find((c) => c.on !== false);
        if (!first) return json({ error: '没有可写的日历' }, 400);
        calHref = first.href;
      }
      if (!/^https?:\/\//i.test(calHref)) calHref = DAV.absUrl(calHref);

      const isNew = !ev.href;
      const uidStr = ev.uid && !isNew ? ev.uid.split('::').pop() : (crypto.randomUUID() + '@ivynote');
      const href = isNew ? calHref.replace(/\/$/, '') + '/' + crypto.randomUUID().toUpperCase() + '.ics' : String(ev.href);
      const ics = DAV.buildIcs({
        uid: uidStr, title,
        start,
        end: Number(ev.end) || start + (ev.allDay ? DAY : 3600000),
        allDay: !!ev.allDay,
        location: ev.location, notes: ev.notes,
        rrule: ev.rrule || ''
      });
      const r = await DAV.putEvent(auth, href, ics, ev.etag || '');
      if (r.error === 'conflict') return json({ error: '这条事件刚被别的设备改过，刷新一下再试' }, 409);
      if (r.error) return json({ error: '写入 iCloud 失败：' + r.error, detail: r.detail || '' }, 502);

      const key = rowUid(calHref, uidStr);
      const calName = (calList(row).find((c) => c.href === calHref) || {}).name || '';
      await env.DB.prepare(`INSERT INTO calendar_events
          (user_id, uid, cal, color, title, start, end, all_day, location, notes, updated_at, href, etag)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
          ON CONFLICT(user_id, uid) DO UPDATE SET
            title=excluded.title, start=excluded.start, end=excluded.end, all_day=excluded.all_day,
            location=excluded.location, notes=excluded.notes, updated_at=excluded.updated_at,
            href=excluded.href, etag=excluded.etag`)
        .bind(uid, key, calName, '', title, start, Number(ev.end) || start + (ev.allDay ? DAY : 3600000),
              ev.allDay ? 1 : 0, ev.location || '', ev.notes || '', Date.now(), href, r.etag || '').run();

      return json({ ok: true, uid: key, href, etag: r.etag || '', created: isNew });
    }

    /* ---------------- 写回：删除 ---------------- */
    if (action === 'remove') {
      const href = String(body.href || '');
      if (!href) return json({ error: '缺 href' }, 400);
      const r = await DAV.deleteEvent(auth, href, String(body.etag || ''));
      if (r.error === 'conflict') return json({ error: '这条事件刚被别的设备改过，刷新一下再试' }, 409);
      if (r.error) return json({ error: '删除失败：' + r.error }, 502);
      await env.DB.prepare('DELETE FROM calendar_events WHERE user_id = ?1 AND href = ?2')
        .bind(uid, href).run();
      return json({ ok: true });
    }

    return json({ error: '不认识的操作 ' + action }, 400);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
