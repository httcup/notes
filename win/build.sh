#!/bin/bash
# 交叉编译 Windows 客户端并打包到 public/dl/（供网页「客户端下载」用）
set -euo pipefail
cd "$(dirname "$0")"
PUB="../public/dl"
mkdir -p "$PUB" build

echo "==> 1/3 编译 Windows exe（amd64，纯 Go 无 CGO）"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-H=windowsgui -s -w" -o "build/随手记笔记本.exe" main.go

echo "==> 2/3 打包 zip"
rm -f "$PUB/IvyNote-Windows.zip"
cp 使用说明.txt build/使用说明.txt
(cd build && zip -q -X "../$PUB/IvyNote-Windows.zip" "随手记笔记本.exe" "使用说明.txt")

echo "==> 3/3 完成"
ls -lh "$PUB/IvyNote-Windows.zip" | awk '{print "产物: "$9" ("$5")"}'
