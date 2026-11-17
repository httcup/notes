// /mcp  MCP（Model Context Protocol）端点：让 Claude / Cursor 等 AI 工具读写笔记
//
// 鉴权：Authorization: Bearer ivy_pat_xxx（在「API 令牌与 MCP」里创建）
// 传输：Streamable HTTP —— POST 进来 JSON-RPC，返回 application/json
//
// 支持：initialize / tools/list / tools/call / ping / notifications/*

import { json } from './_lib.js';

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const TOOLS = [
  {
    name: 'search_notes',
    description: '按关键词搜索我的笔记（标题和正文），返回命中的笔记摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，留空则返回最近的笔记' },
        limit: { type: 'number', description: '最多返回几条，默认 10，上限 50' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_note',
    description: '按 id 读取一篇笔记的完整内容（Markdown）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '笔记 id' } },
      required: ['id']
    }
  },
  {
    name: 'list_recent',
    description: '列出最近编辑过的笔记。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '默认 10，上限 50' } }
    }
  },
  {
    name: 'create_note',
    description: '新建一篇笔记，返回新笔记的 id。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题' },
        body: { type: 'string', description: '正文，支持 Markdown' },
        notebookId: { type: 'string', description: '可选，放进哪个笔记本（先调 list_notebooks 拿 id）' }
      },
      required: ['title']
    }
  },
  {
    name: 'update_note',
    description: '改写一篇笔记的标题或正文（整段替换）。只想追加内容请用 append_note。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记 id' },
        title: { type: 'string', description: '新的标题，不传则不改' },
        body: { type: 'string', description: '新的正文（整段替换），不传则不改' }
      },
      required: ['id']
    }
  },
  {
    name: 'append_note',
    description: '在一篇笔记末尾追加内容，不会覆盖原有正文。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记 id' },
        text: { type: 'string', description: '要追加的 Markdown 文本' }
      },
      required: ['id', 'text']
    }
  },
  {
    name: 'list_notebooks',
    description: '列出所有笔记本（含 id），用于把新笔记归类。',
    inputSchema: { type: 'object', properties: {} }
  }
];

function clamp(n, min, max, dflt) {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.max(min, Math.min(max, Math.round(v)));
}
function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}
function fmtDate(ts) {
  if (!ts) return '';
  // Worker 跑在 UTC，直接按本地时区格式化会差 8 小时
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(ts));
  } catch (e) {
    return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }
}
function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}
function errResult(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true };
}

async function authToken(request, env) {
  const authz = request.headers.get('authorization') || '';
  const m = authz.match(/^Bearer\s+(ivy_pat_[A-Za-z0-9_-]+)$/i);
  if (!m) return null;
  const hash = await sha256hex(m[1]);
  const row = await env.DB.prepare(
    'SELECT id, user_id FROM api_tokens WHERE hash = ?1 AND revoked = 0'
  ).bind(hash).first();
  if (!row) return null;
  // 更新最后使用时间；失败了也不影响本次调用
  try {
    await env.DB.prepare('UPDATE api_tokens SET last_used_at = ?1 WHERE id = ?2').bind(Date.now(), row.id).run();
  } catch (e) {}
  return { uid: row.user_id, tokenId: row.id };
}

async function notebookList(env, uid) {
  const res = await env.DB.prepare(
    'SELECT id, name, deleted FROM notebooks WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 200'
  ).bind(uid).all();
  return (res.results || []).filter((r) => !r.deleted).map((r) => ({ id: r.id, name: r.name || '未命名' }));
}

async function runTool(name, args, env, uid) {
  args = args && typeof args === 'object' ? args : {};

  if (name === 'search_notes' || name === 'list_recent') {
    const limit = clamp(args.limit, 1, 50, 10);
    const q = String(args.query == null ? '' : args.query).trim();
    let rows;
    if (q) {
      const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      const res = await env.DB.prepare(
        `SELECT id, title, notebook_id, updated_at, substr(body, 1, 200) AS snip
           FROM notes
          WHERE user_id = ?1 AND deleted = 0 AND trashed = 0
            AND (title LIKE ?2 ESCAPE '\\' OR body LIKE ?2 ESCAPE '\\')
          ORDER BY updated_at DESC LIMIT ?3`
      ).bind(uid, like, limit).all();
      rows = res.results || [];
    } else {
      const res = await env.DB.prepare(
        `SELECT id, title, notebook_id, updated_at, substr(body, 1, 200) AS snip
           FROM notes
          WHERE user_id = ?1 AND deleted = 0 AND trashed = 0
          ORDER BY updated_at DESC LIMIT ?2`
      ).bind(uid, limit).all();
      rows = res.results || [];
    }
    if (!rows.length) return textResult(q ? `没有找到包含「${q}」的笔记。` : '还没有笔记。');
    const nbs = await notebookList(env, uid);
    const nbName = (id) => (nbs.find((x) => x.id === id) || {}).name || '';
    const lines = rows.map((r) => {
      const nb = r.notebook_id ? ` · ${nbName(r.notebook_id)}` : '';
      const snip = String(r.snip || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return `- **${r.title || '无标题'}**\n  id: \`${r.id}\` · 更新 ${fmtDate(r.updated_at)}${nb}\n  ${snip ? snip + '…' : ''}`;
    });
    return textResult(`找到 ${rows.length} 篇：\n\n${lines.join('\n')}`);
  }

  if (name === 'get_note') {
    const id = str(args.id, 80).trim();
    if (!id) return errResult('缺少笔记 id');
    const r = await env.DB.prepare(
      'SELECT id, title, body, notebook_id, tags, updated_at, created_at FROM notes WHERE user_id = ?1 AND id = ?2 AND deleted = 0'
    ).bind(uid, id).first();
    if (!r) return errResult(`没有 id 为 ${id} 的笔记`);
    let tags = [];
    try { tags = JSON.parse(r.tags || '[]'); } catch (e) {}
    const nbs = await notebookList(env, uid);
    const nb = r.notebook_id ? (nbs.find((x) => x.id === r.notebook_id) || {}).name || '' : '';
    const head = `# ${r.title || '无标题'}\n\n> id: ${r.id} · 更新 ${fmtDate(r.updated_at)}${nb ? ' · 笔记本：' + nb : ''}${tags.length ? ' · 标签：' + tags.join('、') : ''}\n\n`;
    return textResult(head + String(r.body || ''));
  }

  if (name === 'create_note') {
    const title = str(args.title, 500).trim() || '无标题';
    const body = typeof args.body === 'string' ? args.body.slice(0, 400000) : '';
    let notebookId = str(args.notebookId, 80).trim() || null;
    if (notebookId) {
      const nbs = await notebookList(env, uid);
      if (!nbs.some((x) => x.id === notebookId)) notebookId = null;
    }
    const id = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO notes (user_id, id, title, body, notebook_id, tags, trashed, deleted, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, '[]', 0, 0, ?6, ?6)`
    ).bind(uid, id, title, body, notebookId, now).run();
    return textResult(`已创建笔记《${title}》\nid: ${id}\n（打开客户端同步一下就能看到）`);
  }

  if (name === 'update_note') {
    const id = str(args.id, 80).trim();
    if (!id) return errResult('缺少笔记 id');
    const cur = await env.DB.prepare(
      'SELECT id, title, body FROM notes WHERE user_id = ?1 AND id = ?2 AND deleted = 0'
    ).bind(uid, id).first();
    if (!cur) return errResult(`没有 id 为 ${id} 的笔记`);
    const title = typeof args.title === 'string' ? str(args.title, 500) : cur.title;
    const body = typeof args.body === 'string' ? args.body.slice(0, 400000) : cur.body;
    await env.DB.prepare(
      'UPDATE notes SET title = ?1, body = ?2, updated_at = ?3 WHERE user_id = ?4 AND id = ?5'
    ).bind(title, body, Date.now(), uid, id).run();
    return textResult(`已更新《${title || '无标题'}》（id: ${id}）`);
  }

  if (name === 'append_note') {
    const id = str(args.id, 80).trim();
    const text = typeof args.text === 'string' ? args.text.slice(0, 200000) : '';
    if (!id) return errResult('缺少笔记 id');
    if (!text) return errResult('缺少要追加的内容');
    const cur = await env.DB.prepare(
      'SELECT id, title, body FROM notes WHERE user_id = ?1 AND id = ?2 AND deleted = 0'
    ).bind(uid, id).first();
    if (!cur) return errResult(`没有 id 为 ${id} 的笔记`);
    const old = String(cur.body || '');
    const next = old.replace(/\s+$/, '') + (old.trim() ? '\n\n' : '') + text;
    await env.DB.prepare(
      'UPDATE notes SET body = ?1, updated_at = ?2 WHERE user_id = ?3 AND id = ?4'
    ).bind(next.slice(0, 400000), Date.now(), uid, id).run();
    return textResult(`已追加到《${cur.title || '无标题'}》（id: ${id}）`);
  }

  if (name === 'list_notebooks') {
    const nbs = await notebookList(env, uid);
    if (!nbs.length) return textResult('还没有笔记本。');
    return textResult(nbs.map((n) => `- ${n.name}　id: \`${n.id}\``).join('\n'));
  }

  return errResult(`未知工具：${name}`);
}

async function handleOne(msg, env, uid) {
  const id = msg && Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : null;
  const method = String((msg && msg.method) || '');

  if (method === 'initialize') {
    const pv = (msg.params && msg.params.protocolVersion) || '2024-11-05';
    return ok(id, {
      protocolVersion: pv,
      capabilities: { tools: {} },
      serverInfo: { name: 'ivynote', version: '1.0.0' },
      instructions: '这里是「随手笔记」。可以搜索、读取、新建、改写和追加笔记，改动会同步到所有设备。'
    });
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = String((msg.params && msg.params.name) || '');
    const args = (msg.params && msg.params.arguments) || {};
    try {
      const result = await runTool(name, args, env, uid);
      return ok(id, result);
    } catch (e) {
      return ok(id, errResult('执行失败：' + (e && e.message ? e.message : '未知错误')));
    }
  }
  if (method.startsWith('notifications/')) return null;
  if (method === 'resources/list') return ok(id, { resources: [] });
  if (method === 'prompts/list') return ok(id, { prompts: [] });

  return fail(id, -32601, `不支持的方法：${method}`);
}

export async function onRequest({ request, env }) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (request.method === 'GET') {
    // 不提供 SSE 长连接；客户端用 POST 就够了
    return new Response(JSON.stringify({ error: '用 POST 调用 MCP' }), {
      status: 405,
      headers: Object.assign({ 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' }, cors)
    });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
    });
  }
  if (!env.DB) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: '还没绑定数据库' } }), {
      status: 503,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
    });
  }

  let auth = null;
  try {
    auth = await authToken(request, env);
  } catch (e) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: '鉴权失败' } }), {
      status: 500,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
    });
  }
  if (!auth) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '令牌无效或已吊销' } }), {
      status: 401,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
    });
  }

  const raw = await request.json().catch(() => null);
  if (!raw) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '不是合法的 JSON' } }), {
      status: 400,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
    });
  }

  try {
    if (Array.isArray(raw)) {
      const out = [];
      for (const msg of raw) {
        const r = await handleOne(msg, env, auth.uid);
        if (r) out.push(r);
      }
      if (!out.length) return new Response(null, { status: 202, headers: cors });
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
      });
    }
    const one = await handleOne(raw, env, auth.uid);
    if (!one) return new Response(null, { status: 202, headers: cors });
    return new Response(JSON.stringify(one), {
      status: 200,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
    });
  } catch (e) {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: raw && raw.id != null ? raw.id : null,
      error: { code: -32603, message: '服务暂时不可用：' + (e && e.message ? e.message : '未知错误') }
    }), {
      status: 424,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
    });
  }
}
