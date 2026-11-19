#!/bin/bash
# 构建「随手笔记.app」：Swift 编译 + 图标 + Info.plist + ad-hoc 签名
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="随手笔记"
BUNDLE_ID="cn.139t.noteapp"
BUILD_DIR="build"
APP="$BUILD_DIR/$APP_NAME.app"

echo "==> 1/7 生成图标"
python3 make_icon.py

echo "==> 2/7 编译 Swift（arm64 + x86_64，合成通用二进制）"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 -target arm64-apple-macos13 \
  -framework Cocoa -framework WebKit -framework UserNotifications \
  -o "$BUILD_DIR/IvyNote-arm64" main.swift local_server.swift web_updater.swift
swiftc -O -swift-version 5 -target x86_64-apple-macos13 \
  -framework Cocoa -framework WebKit -framework UserNotifications \
  -o "$BUILD_DIR/IvyNote-x86_64" main.swift local_server.swift web_updater.swift
lipo -create "$BUILD_DIR/IvyNote-arm64" "$BUILD_DIR/IvyNote-x86_64" -output "$APP/Contents/MacOS/IvyNote"
rm -f "$BUILD_DIR/IvyNote-arm64" "$BUILD_DIR/IvyNote-x86_64"
lipo -info "$APP/Contents/MacOS/IvyNote"

echo "==> 3/7 写入 Info.plist"
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
  <key>CFBundleShortVersionString</key><string>1.2</string>
  <key>CFBundleVersion</key><string>3</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>随手笔记 · n.139t.cn</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key><false/>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

cp "$BUILD_DIR/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# 内置网页：页面、图标、mermaid 都打进 App，断网时不用下载任何东西
# dl/ 里是给其它平台用的安装包，没必要塞进 Mac App
echo "==> 4/7 内置网页资源"
mkdir -p "$APP/Contents/Resources/web"
rsync -a --delete --exclude 'dl' --exclude '.DS_Store' ../public/ "$APP/Contents/Resources/web/"

echo "==> 5/7 ad-hoc 签名"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "（签名失败，仍可直接运行）"

echo "==> 6/7 打包下载用 zip"
PUB="../public/dl"
mkdir -p "$PUB"
rm -f "$PUB/note-MacOS.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$PUB/note-MacOS.zip"

echo "==> 7/7 完成"
du -sh "$APP" | awk '{print "体积: "$1}'
echo "产物: $(pwd)/$APP"
