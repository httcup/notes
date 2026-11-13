#!/bin/sh
# 发布脚本：先同步版本号到 public/version.js，再部署到生产分支 release
# 用法：./deploy.sh            （版本号取自 public/index.html 的 window.IVY_BUILD）
# 注意：只部署不提交时，页面的「线上版本检测」仍会读 GitHub main，必要时记得 git push
set -e
cd "$(dirname "$0")"

python3 - <<'PY'
import re, sys
h = open('public/index.html', encoding='utf-8').read()
m = re.search(r"window\.IVY_BUILD = \{ id: '([^']+)', at: '([^']+)' \};", h)
if not m:
    sys.exit('在 public/index.html 里没找到 window.IVY_BUILD')
v = open('public/version.js', encoding='utf-8').read()
n = re.sub(r"window\.IVY_BUILD = \{ id: '[^']+', at: '[^']+' \};",
           "window.IVY_BUILD = { id: '%s', at: '%s' };" % (m.group(1), m.group(2)), v)
if n != v:
    open('public/version.js', 'w', encoding='utf-8').write(n)
    print('version.js 已同步到 %s' % m.group(1))
else:
    print('version.js 已是 %s' % m.group(1))
PY

npx wrangler pages deploy public --project-name=notes --branch=release --commit-dirty=true
