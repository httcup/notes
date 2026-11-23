#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""苹果日历 → 随手笔记（网页端日历视图的数据源）

浏览器读不到 macOS 的日历，所以由这个脚本在 Mac 上读一遍，把事件推到云端，
网页端只读那份快照。走的是系统自带的 AppleScript 授权，不需要 Apple ID 密码。

用法：
  ./apple-calendar-sync.py --user 账号 --key 口令          # 全量同步（前后各 6 个月）
  ./apple-calendar-sync.py --user 账号 --key 口令 --months 12
  ./apple-calendar-sync.py --dry-run                     # 只读本地、只打印，不联网
  ./apple-calendar-sync.py --list                        # 列出所有日历名字

第一次运行 macOS 会弹「终端想要控制『日历』」，点允许即可。
凭据可以写在 ~/.ivy-calendar.json：{"user":"...","key":"..."}
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

API = 'https://n.139t.cn/api/calevents'
AUTH = 'https://n.139t.cn/api/auth'
CONF = os.path.expanduser('~/.ivy-calendar.json')

SEP_F = '\x01'   # 字段分隔
SEP_R = '\x02'   # 记录分隔

# 本地 1970-01-01 00:00 的 Unix 时间戳（中国 = -28800）
LOCAL_OFF = int(datetime(1970, 1, 1).timestamp())


def osascript(script, timeout=180):
    p = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or 'osascript 失败')
    return p.stdout


def list_calendars():
    out = osascript('tell application "Calendar" to get name of every calendar')
    return [s.strip() for s in out.strip().split(',') if s.strip()]


# AppleScript 里逐条取属性很慢，所以一次性把整段拼出来，用不可见字符分隔。
# 时间用「本地墙上时间距 1970-01-01 00:00 的秒数」，Python 侧按 UTC 格式化即得本地时间。
APPLESCRIPT = r'''
on run argv
  set epochLocal to current date
  set year of epochLocal to 1970
  set month of epochLocal to January
  set day of epochLocal to 1
  set hours of epochLocal to 0
  set minutes of epochLocal to 0
  set seconds of epochLocal to 0

  set fromTs to (item 1 of argv) as integer
  set toTs to (item 2 of argv) as integer

  set out to ""
  set sf to ASCII character 1
  set sr to ASCII character 2

  tell application "Calendar"
    repeat with cal in calendars
      set calName to name of cal
      try
        set evs to (every event of cal whose start date is greater than or equal to (epochLocal + fromTs) and start date is less than or equal to (epochLocal + toTs))
      on error
        set evs to {}
      end try
      repeat with e in evs
        try
          set u to uid of e
          set t to summary of e
          set s to ((start date of e) - epochLocal) as integer
          set en to ((end date of e) - epochLocal) as integer
          set ad to "0"
          if allday event of e then set ad to "1"
          set loc to ""
          try
            set loc to location of e
          end try
          set dsc to ""
          try
            set dsc to description of e
          end try
          if t is missing value then set t to ""
          if u is missing value then set u to ""
          set out to out & u & sf & calName & sf & t & sf & (s as string) & sf & (en as string) & sf & ad & sf & loc & sf & dsc & sr
        end try
      end repeat
    end repeat
  end tell
  return out
end run
'''


def read_events(days_back, days_forward):
    """返回 [{'uid','cal','title','start','end','allDay','location','notes'}]"""
    now = int(datetime.now().timestamp())
    frm = now - days_back * 86400
    to = now + days_forward * 86400
    out = _run_with_args(frm, to)
    rows = [r for r in out.split(SEP_R) if r.strip()]
    events = []
    seen = set()
    for r in rows:
        f = r.split(SEP_F)
        if len(f) < 8:
            continue
        uid, cal, title, s, e, ad, loc, dsc = f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7]
        uid = uid.strip()
        title = (title or '').strip()
        if not uid or not title:
            continue
        if uid in seen:
            continue
        seen.add(uid)
        try:
            # AppleScript 给的是「本地墙钟距 1970-01-01 00:00 的秒数」，
            # 减掉本地时区偏移才是标准 Unix 时间，前端才能正常显示成本地时刻
            start = (int(float(s)) + LOCAL_OFF) * 1000
            end = (int(float(e)) + LOCAL_OFF) * 1000
        except ValueError:
            continue
        # 提醒事项（VTODO）导进来的条目是零时长（start == end），苹果日历里显示成一条待办，
        # 这里也当全天处理，否则前端会把它显示成「00:00」这种奇怪时间
        if ad.strip() != '1' and end <= start:
            ad = '1'
        events.append({
            'uid': uid,
            'cal': (cal or '').strip(),
            'title': title[:300],
            'start': start,
            'end': max(start, end),
            'allDay': ad.strip() == '1',
            'location': (loc or '').strip()[:300],
            'notes': (dsc or '').strip()[:2000],
        })
    return events


def _run_with_args(frm, to):
    # osascript 的 on run argv：用 -e 传脚本、后面跟参数
    p = subprocess.run(
        ['osascript', '-e', APPLESCRIPT, str(frm), str(to)],
        capture_output=True, text=True, timeout=300
    )
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or 'osascript 失败')
    return p.stdout


def post_json(url, payload, token=None):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST')
    # 不带 UA 会被 Cloudflare 当成脚本直接 403
    req.add_header('user-agent', 'ivynote-calendar-sync/1.0')
    req.add_header('content-type', 'application/json')
    if token:
        req.add_header('authorization', 'Bearer ' + token)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def login(user, key):
    d = post_json(AUTH, {'name': user, 'key': key})
    tok = d.get('token') or d.get('key') or ''
    if not tok:
        raise RuntimeError('登录失败：' + json.dumps(d, ensure_ascii=False))
    return tok


def fmt(ts):
    return datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d %H:%M')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--user', default='')
    ap.add_argument('--key', default='')
    ap.add_argument('--months', type=int, default=6, help='前后各取几个月')
    ap.add_argument('--list', action='store_true', help='只列出日历名字')
    ap.add_argument('--dry-run', action='store_true', help='只读本地并打印，不联网')
    ap.add_argument('--api', default=API)
    a = ap.parse_args()

    if a.list:
        for n in list_calendars():
            print(n)
        return

    cfg = {}
    if os.path.exists(CONF):
        try:
            cfg = json.load(open(CONF, encoding='utf-8'))
        except Exception:
            cfg = {}
    user = a.user or cfg.get('user', '')
    key = a.key or cfg.get('key', '')

    days = max(1, a.months) * 30
    print(f'读取日历（前 {a.months} 个月 / 后 {a.months} 个月）…')
    events = read_events(days, days)
    print(f'读到 {len(events)} 条事件')

    by_cal = {}
    for e in events:
        by_cal[e['cal']] = by_cal.get(e['cal'], 0) + 1
    for cal, n in sorted(by_cal.items(), key=lambda x: -x[1]):
        print(f'  {cal}: {n}')

    if a.dry_run:
        for e in events[:15]:
            print(f"  [{fmt(e['start'])}] {e['cal']} | {e['title']}")
        if len(events) > 15:
            print(f'  …还有 {len(events) - 15} 条')
        return

    if not user or not key:
        print('缺少账号或口令。用 --user / --key 传入，或写进 ' + CONF)
        sys.exit(1)

    token = login(user, key)
    print('已登录，开始上传…')
    now = datetime.now().timestamp() * 1000
    r = post_json(a.api, {
        'events': events,
        'full': True,
        'from': now - days * 86400000,
        'to': now + days * 86400000,
    }, token)
    print(json.dumps(r, ensure_ascii=False))


if __name__ == '__main__':
    main()
