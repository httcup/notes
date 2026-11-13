#!/bin/bash
# 构建「小胡笔记.app」：Swift 编译 + 图标 + Info.plist + ad-hoc 签名
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="小胡笔记"
BUNDLE_ID="cn.139t.noteapp"
BUILD_DIR="build"
APP="$BUILD_DIR/$APP_NAME.app"

echo "==> 1/5 生成图标"
python3 make_icon.py

echo "==> 2/5 编译 Swift"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 \
  -framework Cocoa -framework WebKit -framework UserNotifications \
  -o "$APP/Contents/MacOS/IvyNote" main.swift

echo "==> 3/5 写入 Info.plist"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleExecutable</key><string>IvyNote</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>小胡小胡的笔记 · n.139t.cn</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsArbitraryLoads</key><false/></dict>
</dict>
</plist>
PLIST

cp "$BUILD_DIR/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> 4/5 ad-hoc 签名"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "（签名失败，仍可直接运行）"

echo "==> 5/5 完成"
du -sh "$APP" | awk '{print "体积: "$1}'
echo "产物: $(pwd)/$APP"
