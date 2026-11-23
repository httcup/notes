#!/bin/bash
# 双击运行：把 Mac 上的苹果日历同步到随手笔记的日历视图
# 第一次会问账号和口令，之后只存本机（~/.ivy-calendar.json，仅本人可读）
cd "$(dirname "$0")" || exit 1

PY="/Users/mlx/.workbuddy/binaries/python/versions/3.13.12/bin/python3"
if [ ! -x "$PY" ]; then PY="$(command -v python3)"; fi
if [ -z "$PY" ]; then echo "没找到 python3"; read -n 1 -s -r -p "按任意键关闭…"; exit 1; fi

CONF="$HOME/.ivy-calendar.json"
if [ ! -f "$CONF" ]; then
  echo "第一次使用，先把账号记在本机（不会上传，只在同步时用来登录）"
  printf "随手笔记账号："
  read -r U
  printf "口令："
  read -r -s K
  echo
  if [ -z "$U" ] || [ -z "$K" ]; then echo "账号或口令为空，退出"; read -n 1 -s -r -p "按任意键关闭…"; exit 1; fi
  printf '{"user":"%s","key":"%s"}' "$U" "$K" > "$CONF"
  chmod 600 "$CONF"
  echo "已记住，下次不用再输"
  echo
fi

"$PY" apple-calendar-sync.py --months 6
echo
read -n 1 -s -r -p "同步完成，按任意键关闭…"
