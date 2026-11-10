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
- 绑定 D1：变量名 `DB`；绑定 KV：变量名 `MEDIA`（可选再绑 R2：`BUCKET`）

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
