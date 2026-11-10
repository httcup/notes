# notes · 小胡小胡的笔记（云同步版）

一个本地优先、云端同步的 Markdown 笔记应用。界面参考 ivyNote（官网https://ivynote.app/） 重写，
数据存在自己的 Cloudflare 账号里。
- 线上地址：https://notes-4fi.pages.dev
- 前端：单文件 `public/index.html`（原生 HTML/CSS/JS，零构建、零依赖）
- 后端：Cloudflare Pages Functions（`functions/api/sync.js`）
- 数据库：Cloudflare D1（`ivynote`），按 `user_id` 隔离
- 文件：Cloudflare KV（`ivynote_media`），绑了 R2 会自动优先用 R2
- 鉴权：`POST /api/auth` 换 90 天令牌（Bearer）；主人账号也兼容旧的 `x-ivy-key` 单口令

## 首次使用

打开线上地址 → 点左下角云朵图标：

- **主人账号**：账号留空，口令填 `IVY_KEY`（部署时设的环境变量）
- **新账号**：填一个账号名 + 口令，点「注册新账号」，就是一个独立空间，和主人账号数据完全隔离

登录状态存在本机 localStorage，令牌 90 天有效，过期后自动用记住的口令续期。

## 目录

```
public/index.html      应用本体（三栏布局、编辑器、大纲、关系图、媒体库）
functions/api/sync.js  同步接口 GET/POST /api/sync
schema.sql             D1 表结构
wrangler.toml          D1 绑定（仅本地开发与 d1 命令使用，构建配置在控制台）
```

## 功能

- 多账号：账号名 + 口令注册，数据按 `user_id` 隔离；主人账号沿用单口令
- 双链：点工具栏「双链」或直接输入 `[[`，会弹出笔记选择器；写 `[[笔记标题]]` 即变成绿色胶囊，点一下跳到那篇；标题不存在时点击会自动新建并跳过去；输入 `[[` 会弹出笔记列表（前缀匹配优先），↑↓ 选择、回车插入、「新建 xxx」永远排在最后
- 所见即所得编辑：光标所在的块显示 Markdown 源码，离开（回车 / 点别处）立刻渲染成排版；块内回车自动续写列表、待办、编号，标题回车自动另起一段
- 书架式侧边栏、多标签页、笔记本分组（可重命名 / 删除，删掉后里面的笔记自动移到「未归类」）、回收站（全新安装是空库，不带示例笔记）
- 图片粘贴/拖拽即上传到 KV，返回稳定 URL，换设备打开笔记照样显示
- 标题下 Markdown 工具条：H2/H3、加粗、斜体、删除线、行内代码、列表、编号、待办、引用、链接、表格、代码块、分割线
- 导出：复制富文本（带格式，可直接粘进 Word/飞书）、复制 Markdown、导出 .md 文件（文件名 `标题 2026-11-09.md`）
- 三种视图（`⋯` 菜单里勾选，⌘E 轮转）：**即时渲染**（默认，边写边排版）/ **源码**（纯 Markdown）/ **双栏**（左源码右预览，实时联动）；标题大纲自动生成
- `[[双链]]` + Canvas 力导向关系图
- 粘贴或拖入图片进媒体库
- 命令面板 ⌘K、⌘N 新建、⌘\ 收起书架、⌥W 关标签
- 明暗双主题
- 云同步：编辑后 0.8s 自动上传（防抖），45s 轮询拉取，切换回页面立即拉取
  - 同步中再有改动会自动续跑，不会丢
  - 断网失败按 1.5s→3s→6s→12s 退避重试
  - 关闭或切走页面时用 `fetch(keepalive)` 兜底上传尚未提交的改动
  - 冲突按 `updatedAt` 后写覆盖

## 接口

`POST /api/auth` body `{ name, key, create }` → `{ token, name, uid }`
- `name` 留空 = 主人账号（比对 `IVY_KEY`）；填名字则查 `users` 表，`create:true` 时注册

`GET /api/sync` → `{ notes, notebooks, serverTime }`

`POST /api/sync` body `{ notes, notebooks }` → 服务端按 `updatedAt` 做 upsert 合并，返回合并后的全量数据。

- `trashed=1` 为回收站，`deleted=1` 为彻底删除（墓碑，只用于让其他设备同步删除）
- 请求头缺失或令牌无效返回 401

`POST /api/share` body `{ noteId, title, body }`（需登录）→ `{ slug }`，同一篇笔记复用同一个 slug，内容会更新
`GET /api/share?slug=xx` → `{ title, body, createdAt, updatedAt }`（公开，无需登录）
`DELETE /api/share?noteId=xx`（需登录）→ 取消分享，链接立即失效
`GET /s/<slug>` → 只读分享页（`public/s.html` 渲染）

`GET /api/media` → `{ items:[{id,url,name,size,type,createdAt}] }`（仅本人）
`POST /api/media`（multipart，字段 `file`，≤20MB）→ 同上单条
`GET /api/media/:uid/:id` → 文件本体（公开，靠 32 位随机 key 不可猜）
`DELETE /api/media/:uid/:id` → 需本人令牌

`POST /api/capture` body `{ url, title, text, source, notebook }`（需 `x-capture-key` 或登录态）→ 把外部网页/微博/微信文章写成一条笔记，落在「剪藏」笔记本，返回 `{ noteId, mode, via, format }`。同一链接重复保存会更新同一篇（id 由链接哈希生成）。除 JSON 外也接受表单、纯文本、嵌套 JSON。
`GET /api/capture?k=<CAPTURE_KEY>&url=<文章地址>` → 直接剪藏，给只能发 GET 的 webhook 用。
`GET /api/capture?k=<CAPTURE_KEY>` → 手机浏览器里粘贴链接的极简表单页。

`POST /api/pdf`（需 `x-pdf-key: <PDF_IMPORT_KEY>` 或 `x-capture-key`）→ 把 **PDF 或图片（长图）** 转成结构化 Markdown 写进「PDF 导入」笔记本，返回 `{ ok, noteId, title, notebook, noteUrl, pdfUrl, fileUrl, kind, mime, mode, chars, tokens }`。`kind=pdf|image`；原始文件同时存进媒体库，笔记末尾附链接；识别不出文字时只存原件（`mode=original`）。同一份文件重复推送按内容哈希只更新同一篇笔记。

`POST /api/note` body `{ markdown, title, notebook, source, id }` → 把**已经转好的 Markdown** 直接写进「导入」笔记本，返回 `{ ok, noteId, title, notebook, noteUrl, chars }`。长图、截图、聊天里整理好的文字都走这里；不给 `id` 时按内容哈希幂等。

> `/api/capture`（网页剪藏）、`/api/pdf`（PDF 转 Markdown）、`/api/note`（现成 Markdown 入库）是三条「往里写」的入口，其余接口都是往外读或全量同步。
> `mode=full` 抓到正文、`mode=link` 只存了标题/链接/分享文字；`via=direct`（网页直连）、`weibo-api`（微博官方移动端接口）、`reader`（第三方 Reader 兜底）、`link`（降级）；`format=json|form|text|query` 表示这次请求是怎么被解析的。请求加 `?debug=1` 会额外返回 `diag` 数组，记录每一路抓取的状态，线上排障用。

抓取策略（踩过的坑）：

- **微信公众号 / 普通网页**：直连。页面常有 3MB+，正文 `#js_content` 可能在 600KB 之后，所以必须读全页、先在完整 HTML 上剔掉 `<script>/<style>`，再按标签栈精确切出 `#js_content` 容器。早期版本先截断 400KB 再清洗，导致脚本未闭合、JS 源码被当成正文写进笔记。
- **微博普通状态**：网页直连一律返回 Sina Visitor System，但移动端公开 JSON 接口 `m.weibo.cn/statuses/show?id=<id>` 只要带上 `Referer: https://m.weibo.cn/` 和 `X-Requested-With: XMLHttpRequest` 就能直出正文，**不需要访客 Cookie**。长微博再调 `statuses/extend` 补 `longTextContent`，图片/作者/转发原文一起转 Markdown。这是主通道，无第三方依赖。
- **微博头条文章**：官方 AJAX 接口需要签名/登录（返回「系统繁忙」），访客 Cookie 也解不开，只能退回公开 Reader `https://r.jina.ai/<规范化地址>` 取渲染后的 Markdown；官方接口失效时普通微博也走这个兜底。免费 Reader 对机房 IP 常返回 429，端点内置一次重试；配置 `JINA_API_KEY` 后额度更高。
- 抓到脚本碎片、访客验证页或解码乱码时**一律降级**，绝不写脏数据进笔记。
- Reader 兜底会把**公开链接**发给第三方服务。介意的话在 Pages 环境变量里设 `CAPTURE_JINA=0` 关闭，退回「标题 + 原链接 + 分享文字」的降级快照。

### 手机里怎么用（对应印象笔记的「转发即收藏」）

1. Cloudflare 控制台给 Pages 项目加 Secret `CAPTURE_KEY`（`openssl rand -hex 24` 生成一串），push 后自动部署。
2. iOS 快捷指令新建「存到我的笔记」，打开「在共享表单中显示」，接收 URL / 文本：
   - 从「快捷指令输入」里取 URL → 存为变量「链接」
   - 「获取 URL 内容」：`POST https://n.139t.cn/api/capture`，头部 `x-capture-key: <CAPTURE_KEY>`，
     请求体 JSON `{"url":"链接","text":"快捷指令输入","source":"wechat"}`
   - 「显示通知」展示返回结果里的 `title`，`mode=link` 时提示只存到了链接
3. 微信 / 微博里点分享 → 选这条快捷指令 → 笔记站 45 秒轮询或重新打开后会多出「剪藏」笔记本。
4. 不想配快捷指令，也可以直接在手机浏览器打开 `https://n.139t.cn/api/capture?k=<CAPTURE_KEY>` 粘贴链接提交；**这个链接带密钥，别外发**。

> 微信「收藏夹」和微博「收藏」没有开放导出接口，做不到把收藏夹自动同步过来；这里实现的是「看到就推一条」的剪藏，和印象笔记官方机器人账号的机制一致，只是把机器人换成了分享菜单里的快捷指令。

### 用 Webhook 推送文章地址

`/api/capture` 本身就是 webhook 接收端点。任何能发 HTTP 请求的地方都能当上游：n8n、Make、IFTTT Webhooks、GitHub Actions、RSSHub + 定时器、Server 酱、企业微信/飞书/Telegram 机器人（需一层中转）、iOS 快捷指令、浏览器书签小工具、curl。密钥放请求头 `x-capture-key`，或放 URL `?k=`（只能改 URL 的服务用后者）。

四种格式都认，消息里只要有一个 http(s) 地址就能触发：

```bash
# 1. JSON（推荐）
curl -X POST 'https://n.139t.cn/api/capture' \
  -H 'content-type: application/json' -H 'x-capture-key: <KEY>' \
  -d '{"url":"https://mp.weixin.qq.com/s/...","title":"可选标题","text":"可选摘抄","source":"n8n"}'

# 2. 表单（IFTTT 及大多数表单型 webhook）
curl -X POST 'https://n.139t.cn/api/capture' -H 'x-capture-key: <KEY>' \
  -d 'url=https%3A%2F%2Fmp.weixin.qq.com%2Fs%2F...&text=备注'

# 3. 纯文本 / 只发一个链接
curl -X POST 'https://n.139t.cn/api/capture' -H 'x-capture-key: <KEY>' \
  --data-binary '看这篇 https://mp.weixin.qq.com/s/... 不错'

# 4. GET（只能发 GET 的服务、书签小工具）
# https://n.139t.cn/api/capture?k=<KEY>&url=https%3A%2F%2Fmp.weixin.qq.com%2Fs%2F...
```

- 字段别名：`url / link / href / target`、`text / content / message / summary`、`title / subject`、`source`、`notebook`；字段包在 `data` / `payload` / `event` 里也能自动找到。
- 没有显式字段时，会从整段消息里抽第一个 http(s) 链接，其余文字作为摘抄一起存；`source` 可填任意来源名（如 `n8n`、`RSSHub`），会写进标签。
- **幂等**：同一地址重复推送只会更新同一篇笔记，webhook 重投不会产生重复笔记。返回 JSON 里看 `mode` 与 `format` 即可确认结果。
- 微博 / 微信自身不会主动推送「新收藏」，上游得是你自己的自动化（RSS、定时任务、机器人中转）或分享菜单。
- ⚠️ `?k=` 形式的 URL 含密钥，别贴到公开仓库、群聊或日志里。

### 把 PDF / 长图转成 Markdown 存进笔记本

`/api/pdf` 是第二条写入通道。**同一个端点、同一条快捷指令**同时收 PDF 和长图（截图），服务端按文件头判断类型，两者都转 Markdown 写进同一个「PDF 导入」笔记本：

```
iOS 快捷指令（分享 PDF 或长图） → POST https://n.139t.cn/api/pdf
  → PDF 走文本抽取；图片走 Qwen 3.8 27B 视觉模型逐字转录中文原文（约 20 秒）
  → 结构化 Markdown → 写进 D1 的「PDF 导入」笔记本 + 原件存进媒体库
  → 笔记站 45 秒轮询或重开页面即可看到
```

- `kind=pdf` → noteId 前缀 `pdf_`、标签「PDF」；`kind=image` → 前缀 `img_`、标签「长图」。笔记本相同，不用分开两条快捷指令。
- 支持 PNG / JPEG / WebP / SVG；HEIC 会明确报错（先转成 JPEG）。图片单独限 10MB（PDF 仍是 20MB）。
- **图片走 `@cf/qwen/qwen3.8-27b` 逐字转录中文原文**（`via=qwen-vl`）。实测 900×2200 中文长图约 19 秒、2330 tokens、约 172 neurons；Workers AI 每日有免费额度，超出会计费。直接对图片用 `toMarkdown` 只会得到**英文内容描述**，所以只在 Qwen 不可用时才降级到它（`via=tomarkdown-image`，并在 `warning` 里写明）；两条路都失败才只存原件。
- 特别高的长图仍可能被模型缩放，小字有丢失风险；可以裁成几段分别推送，或把图交给 WorkBuddy 走下面的 `/api/note`（不经模型缩放、也不消耗 Workers AI 额度）。

部署前置（一次性）：

1. Pages 项目 → Settings → Functions → **Bindings → Add → Workers AI**，变量名填 `AI`（production / preview 都加）；改完要重新部署才生效。
2. 加 Secret `PDF_IMPORT_KEY`（`openssl rand -hex 24` 生成），可选 `PDF_UID`（默认 `owner`）。它和剪藏用的 `CAPTURE_KEY` 相互独立，改它不会影响已有的剪藏快捷指令；端点两个 key 都认。
3. 绑定 D1 `DB` 与 KV `MEDIA`（沿用现有配置即可，无需改表结构）。

**iOS 快捷指令配置**（打开「在共享表单中显示」，接收「文件 / PDF / 图像」）：

| 步骤 | 动作 | 参数 |
| --- | --- | --- |
| 1 | 设置变量 | 变量名 `分享的文件`，值是「快捷指令输入」 |
| 2 | URL | `https://n.139t.cn/api/pdf` |
| 3 | 获取 URL 内容 | 方法 `POST`；请求头加 `x-pdf-key: <PDF_IMPORT_KEY>`；请求体选「表单」，加一个**文件**类型字段 `file`，值选第 1 步的变量 |
| 4 | 获取字典值 | 键 `title`（从上一步的 JSON 响应里取） |
| 5 | 显示通知 | 标题「已存进笔记本」，内容用第 4 步的结果 |

分享 PDF 或长图时都选这一条即可。Mac 上双击已签名好的 `PDF存进笔记本.shortcut` 直接导入（会经 iCloud 同步到 iPhone）。

其他调用方式：

```bash
# multipart（快捷指令走的就是这个）；PDF 和长图只是 MIME 不同
curl -X POST 'https://n.139t.cn/api/pdf' -H 'x-pdf-key: <KEY>' \
  -F 'file=@/path/to/report.pdf;type=application/pdf' -F 'title=可选标题'
curl -X POST 'https://n.139t.cn/api/pdf' -H 'x-pdf-key: <KEY>' \
  -F 'file=@/path/to/长图.png;type=image/png'

# 原始二进制 / JSON base64 / 文件网址
curl -X POST 'https://n.139t.cn/api/pdf' -H 'x-pdf-key: <KEY>' \
  -H 'content-type: image/png' --data-binary @长图.png
curl -X POST 'https://n.139t.cn/api/pdf' -H 'x-pdf-key: <KEY>' \
  -H 'content-type: application/json' -d '{"pdf":"<base64>","filename":"a.pdf"}'
# https://n.139t.cn/api/pdf?k=<KEY>&url=https%3A%2F%2Fexample.com%2Fa.png
```

- `?format=md` 返回纯 Markdown，`?format=html` 返回排版好的 HTML 预览页；`?keep=0` 不存原始文件。
- `GET /api/pdf?k=<KEY>` 是手机浏览器里选 PDF 或图片上传的表单页，不想配快捷指令时用它。
- 上限 20MB；扫描件或识别失败时降级为 `mode=original`，只建一条带原件链接的笔记，不写脏正文。
- 正文是 Markdown，笔记本里可以直接编辑；标题依次取 `title` 字段 → 正文第一个标题 → 文件名。同一份文件重复推送按内容哈希只更新同一篇。

### 任意现成 Markdown → 笔记本

`/api/note` 只负责**入库**，不负责识别。把长图或截图交给 WorkBuddy，由它看图转成 Markdown，再调这个端点写进笔记站（不经模型缩放、也不消耗 Workers AI 额度，适合特别长或字很小的图）：

```bash
curl -X POST 'https://n.139t.cn/api/note' \
  -H 'content-type: application/json' -H 'x-pdf-key: <KEY>' \
  -d '{"title":"读书笔记","markdown":"# 第一章\n\n……","notebook":"资料库","source":"长图"}'
```

- 字段别名 `markdown / md / text / content / body`，也接受表单和纯文本；可选 `title`、`notebook`、`source`、`id`。
- 鉴权和 `/api/pdf` 一样；`?format=html` 返回排版预览页。
- 不给 `id` 时按正文哈希生成 noteId，重复推送只更新同一篇，不会产生重复笔记。

## 部署

### 1. 数据库

```bash
wrangler d1 create ivynote          # 已创建，id 见 wrangler.toml
wrangler d1 execute ivynote --remote --file=schema.sql
```

### 2. Pages 项目

Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git → 选择本仓库：

- Build command：留空
- Build output directory：`public`
- 环境变量 `IVY_KEY`：主人口令（Secret）；`IVY_SECRET`：令牌签名密钥（Secret，随便一串 64 位十六进制）
- 可选 `CAPTURE_KEY`：外部剪藏密钥（Secret，给 `/api/capture` 用，建议 32 位随机串）；可选 `CAPTURE_UID`，默认 `owner`；可选 `CAPTURE_JINA=0` 关闭微博的第三方 Reader 通道；可选 `JINA_API_KEY`（Secret）提高 Reader 限额，用于微博头条文章
- 可选 `PDF_IMPORT_KEY`：`/api/pdf` 的导入密钥（Secret）；可选 `PDF_UID`，默认 `owner`。改它不影响 `CAPTURE_KEY`
- 绑定 D1：变量名 `DB`；绑定 KV：变量名 `MEDIA`（可选再绑 R2：`BUCKET`）；`/api/pdf` 还需要 Workers AI 绑定：变量名 `AI`（Settings → Functions → Bindings → Workers AI）
- 改环境变量或绑定后要重新部署才生效

也可以用 API 一次配好（本项目就是这么部署的）。

> 之后每次 push 到 `main` 都会自动构建部署。

### 3. 本地开发

```bash
wrangler pages dev public --d1=DB=<database_id> --binding IVY_KEY=dev
```

## 说明

- 账号口令经 PBKDF2-SHA256（6 万次迭代）加盐哈希后存 D1，服务端不存明文
- 媒体读取是公开 URL（靠随机 key），需要更严的隔离可以改成签名 URL 或套 Cloudflare Access
- R2 未开通时自动用 KV 存文件；开通后加 `BUCKET` 绑定即可无缝切换
