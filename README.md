# notes · ivyNote 常青笔记（云同步版）

一个本地优先、云端同步的 Markdown 笔记应用。界面参考 [ivyNote](https://ivynote.frytea.com) 复刻重写，数据存在自己的 Cloudflare 账号里。

- 线上地址：https://notes-4fi.pages.dev
- 前端：单文件 `public/index.html`（原生 HTML/CSS/JS，零构建、零依赖）
- 后端：Cloudflare Pages Functions（`functions/api/sync.js`）
- 数据库：Cloudflare D1（`ivynote`）
- 鉴权：单用户口令，请求头 `x-ivy-key`，与 Pages 环境变量 `IVY_KEY` 比对

## 首次使用

打开线上地址 → 点左下角云朵图标 → 粘贴口令（部署时设置的环境变量 `IVY_KEY`）→ 连接。之后每台设备只需输一次，口令存在本机 localStorage。

## 目录

```
public/index.html      应用本体（三栏布局、编辑器、大纲、关系图、媒体库）
functions/api/sync.js  同步接口 GET/POST /api/sync
schema.sql             D1 表结构
wrangler.toml          D1 绑定（仅本地开发与 d1 命令使用，构建配置在控制台）
```

## 功能

- 书架式侧边栏、多标签页、笔记本分组、回收站
- Markdown 源码 / 预览双模式（⌘E），标题大纲自动生成
- `[[双链]]` + Canvas 力导向关系图
- 粘贴或拖入图片进媒体库
- 命令面板 ⌘K、⌘N 新建、⌘\ 收起书架、⌥W 关标签
- 明暗双主题
- 云同步：编辑后 0.8s 自动上传（防抖），45s 轮询拉取，切换回页面立即拉取
  - 同步中再有改动会自动续跑，不会丢
  - 断网失败按 1.5s→3s→6s→12s 退避重试
  - 关闭或切走页面时用 `fetch(keepalive)` 兜底上传尚未提交的改动
  - 冲突按 `updatedAt` 后写覆盖

## 同步接口

`GET /api/sync` → `{ notes, notebooks, serverTime }`

`POST /api/sync` body `{ notes, notebooks }` → 服务端按 `updatedAt` 做 upsert 合并，返回合并后的全量数据。

- `trashed=1` 为回收站，`deleted=1` 为彻底删除（墓碑，只用于让其他设备同步删除）
- 请求头缺失或口令不符返回 401

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
- 环境变量 `IVY_KEY`：设置成自己的口令（Pages → Settings → Variables and Secrets，类型选 Secret）

绑定 D1：Settings → Bindings → 添加 D1 database，变量名 `DB`，选择 `ivynote`。

> 之后每次 push 到 `main` 都会自动构建部署。

### 3. 本地开发

```bash
wrangler pages dev public --d1=DB=<database_id> --binding IVY_KEY=dev
```

## 说明

- 口令只存在浏览器 localStorage，不写进代码库；忘记口令不会丢数据，重新设置环境变量即可。
- 媒体文件目前只在本机会话内有效（未接 R2），笔记文本完全云同步。
