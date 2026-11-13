#!/bin/bash
# 构建 随手记笔记本 Android 客户端（不依赖 Gradle，直接 aapt2 + javac + d8 + apksigner）
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

# --- 找 JDK ---
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME:-}/bin/javac" ]; then
  for c in \
    /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
    /opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home \
    /usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
    /Library/Java/JavaVirtualMachines/*/Contents/Home; do
    if [ -x "$c/bin/javac" ]; then JAVA_HOME="$c"; break; fi
  done
fi
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/javac" ]; then
  echo "找不到 JDK，请先 brew install openjdk@21"; exit 1
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
PLATFORM_JAR="$(ls -d "$SDK"/platforms/android-*/android.jar 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$BT" ] || [ -z "$PLATFORM_JAR" ]; then
  echo "找不到 Android SDK（build-tools / platform）。请先安装："
  echo "  sdkmanager \"platforms;android-34\" \"build-tools;34.0.0\""
  exit 1
fi

APP_ID="cn.t139.noteapp"
OUT="build"
DIST="../public/dl/note-Android.apk"

echo "==> 0/6 清理"
rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes"

echo "==> 1/6 生成图标"
python3 make_icons.py

echo "==> 2/6 编译资源（aapt2）"
"$BT/aapt2" compile --dir app/src/main/res -o "$OUT/res/res.zip"
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$PLATFORM_JAR" \
  --manifest app/src/main/AndroidManifest.xml \
  --java "$OUT/gen" \
  --min-sdk-version 23 \
  --target-sdk-version 34 \
  --version-code 1 \
  --version-name 1.0 \
  "$OUT/res/res.zip"

echo "==> 3/6 编译 Java"
find app/src/main/java "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac -encoding UTF-8 -source 8 -target 8 -nowarn \
  -classpath "$PLATFORM_JAR" \
  -d "$OUT/classes" \
  @"$OUT/sources.txt" 2>&1 | grep -v "^warning:" || true

echo "==> 4/6 转 dex（d8）"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BT/d8" --release --lib "$PLATFORM_JAR" --min-api 23 \
  --output "$OUT" @"$OUT/classes.txt"

echo "==> 5/6 打包 + 对齐"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
( cd "$OUT" && zip -q -j unsigned.apk classes.dex )
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "==> 6/6 签名"
KS="ivynote-release.jks"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -alias ivynote \
    -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass ivynote -keypass ivynote \
    -dname "CN=IvyNote, OU=App, O=IvyNote, L=CN, C=CN" >/dev/null 2>&1
  echo "    已生成签名密钥 ivynote-release.jks（请保留，后续升级要用同一个）"
fi
mkdir -p ../public/dl
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:ivynote --key-pass pass:ivynote \
  --min-sdk-version 23 --out "$DIST" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$DIST" | head -4

SIZE="$(du -h "$DIST" | cut -f1)"
echo "==> 完成: ${DIST} (${SIZE})"
