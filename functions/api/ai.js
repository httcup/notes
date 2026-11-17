// /api/ai  跑一次生成，流式把文字喷回前端
//
// 三种来源，前端用 provider 选：
//   zhipu / spark  站内免费模型（key 只在 Cloudflare 环境变量里，未登录也能用，按 IP 限量）
//   custom         用户自己的接口（加密存在账号里，必须登录）
//
// 为什么流式：长文排版动辄几千字，等整段生成完再返回，前端会像卡死；
// 纯文本流（不是 SSE）让前端只需要 reader.read() + 拼接，不用自己解析协议。
import { json, preflight, currentUser } from '../_lib.js';
import { loadAiConfig, baseBlockReason, siteProviders, publicProviders, quotaLimit, takeQuota } from '../_ai.js';

const MAX_TEXT = 20000;
const MAX_NOTE = 12000;
const MAX_TURNS = 16;

const CHAT_SYS = '你是「随手笔记」应用里的写作助手。回答直接、具体、可执行，默认用中文；'
  + '用户用别的语言提问时跟随用户的语言。需要输出 Markdown 时保证语法正确，'
  + '不要用 ``` 把整段答案包起来，也不要写「好的」「以下是」这类开场白。';

const TASKS = {
  // 对话：messages 由前端给，这里只定输出上限与温度
  chat: {
    label: '对话',
    temperature: 0.7,
    max: 2000
  },
  polish: {
    label: '润色',
    temperature: 0.6,
    max: 2400,
    sys: '你是中文文字编辑。在不改变原意、不增删事实的前提下，把文字改得通顺、准确、自然：'
      + '修掉语病与重复，调整标点与断句。保留原有的 Markdown 语法（标题、列表、引用、代码、链接）。'
      + '只输出修改后的文字，不要解释、不要加代码块围栏。'
  },
  shorten: {
    label: '精简',
    temperature: 0.4,
    max: 2000,
    sys: '你是中文编辑。把文字压缩到原文六成左右，保留关键信息、数字与结论，去掉冗余修饰和重复表述。'
      + '保留 Markdown 结构。只输出压缩后的文字，不要解释。'
  },
  expand: {
    label: '扩写',
    temperature: 0.7,
    max: 3000,
    sys: '你是中文写作者。顺着原文的意思扩写，补充细节、例子和过渡，让内容更完整；'
      + '不得编造具体数据、人名或事实。保留 Markdown 结构。只输出扩写后的文字，不要解释。'
  },
  fix: {
    label: '纠错',
    temperature: 0.2,
    max: 2400,
    sys: '你是校对员。只修正错别字、标点误用、语法错误和明显病句，尽量保留原句与作者语气，'
      + '不要润色、不要改结构。只输出修正后的文字，不要列出改了什么。'
  },
  translate: {
    label: '翻译',
    temperature: 0.3,
    max: 3000,
    sys: '你是翻译。自动判断原文语言：中文译成英文，其他语言译成中文。'
      + '保留 Markdown 语法、专有名词与代码块。只输出译文，不要解释。'
  },
  continue: {
    label: '续写',
    temperature: 0.8,
    max: 2000,
    sys: '你是中文写作者。接着原文往下写一到两段，语气、人称、详略程度与原文保持一致，'
      + '不要重复已有内容，不要总结，不要解释。只输出新增的段落。'
  },
  title: {
    label: '起标题',
    temperature: 0.9,
    max: 400,
    sys: '你是标题编辑。根据内容给出 5 个备选标题，一行一个，不加编号、不加引号、不加说明。'
      + '标题要具体、有信息量，避免标题党和空泛的形容词。'
  },
  summary: {
    label: '摘要',
    temperature: 0.4,
    max: 900,
    sys: '你是编辑。用 3 到 5 条要点总结内容，输出 Markdown 无序列表，每条一句话，'
      + '覆盖结论、关键事实和待办。不要写前言、不要总结「这篇文章讲了」。'
  },
  format: {
    label: '排版',
    temperature: 0.2,
    max: 6000,
    sys: '你是 Markdown 排版助手。只整理结构，不改内容：统一标题层级（保留原有层级关系，不要新增 # 大标题）、'
      + '统一列表符号为 -、表格补齐对齐、合并多余空行、中英文与数字之间补一个空格、'
      + '统一中英文标点。严禁改写、增删、润色任何文字，代码块、链接、图片、待办标记原样保留。'
      + '只输出排版后的全文，不要解释，不要用 ``` 包裹整个结果。'
  }
};

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) : t;
}

function textHeaders(model) {
  return {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-ai-model': encodeURIComponent(model || '')
  };
}

function contentOf(j) {
  if (!j) return '';
  const c = j.choices && j.choices[0];
  const d = c && (c.delta || c.message);
  let t = d && d.content;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map((x) => (x && x.text) || '').join('');
  if (typeof j.response === 'string') return j.response;   // 少数网关回老格式
  return '';
}

/** SSE → 纯文本。上游按行发 data: {...}，这里只认增量文字，其余（角色、用量、思考）丢弃 */
function streamText(upstream) {
  const dec = new TextDecoder();
  const encd = new TextEncoder();
  let buf = '';
  let closed = false;
  return new ReadableStream({
    async start(ctrl) {
      const reader = upstream.getReader();
      const close = () => { if (!closed) { closed = true; try { ctrl.close(); } catch (e) {} } };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') { close(); return; }
            try {
              const t = contentOf(JSON.parse(payload));
              if (t) ctrl.enqueue(encd.encode(t));
            } catch (e) { /* 不完整的一行或心跳，跳过 */ }
          }
        }
      } catch (e) { /* 上游断了：把已经收到的留住，直接收尾 */ }
      close();
    },
    cancel() { try { upstream.cancel(); } catch (e) {} }
  });
}

function providerMessage(code, detail) {
  const d = String(detail || '').slice(0, 180);
  if (code === 401 || code === 403) return '密钥不对或没有权限（HTTP ' + code + '）：' + d;
  if (code === 402) return '账户余额不足（HTTP 402）：' + d;
  if (code === 404) return '地址或模型名不对（HTTP 404）：' + d;
  if (code === 429) return '请求太频繁或额度用完了（HTTP 429）：' + d;
  return '接口返回 HTTP ' + code + '：' + d;
}

function buildMessages(task, body) {
  const t = TASKS[task];
  if (!t) return null;

  if (task === 'chat') {
    const history = Array.isArray(body.messages) ? body.messages.slice(-MAX_TURNS) : [];
    const msgs = [{ role: 'system', content: CHAT_SYS }];
    const note = clip(body.note, MAX_NOTE).trim();
    if (note) {
      msgs.push({
        role: 'system',
        content: '以下是用户当前正在写的笔记，仅在问题与之相关时参考，不要逐段复述：\n\n' + note
      });
    }
    for (const m of history) {
      const role = m && m.role === 'assistant' ? 'assistant' : 'user';
      const content = clip(m && m.content, 8000).trim();
      if (content) msgs.push({ role, content });
    }
    if (msgs.length < 2) return null;
    return msgs;
  }

  const text = clip(body.text, MAX_TEXT).trim();
  if (!text) return null;
  const ask = task === 'format'
    ? '请按排版规则整理下面这篇笔记的全文：\n\n'
    : (task === 'continue'
      ? '下面是已经写好的部分，请接着往下写：\n\n'
      : '请对下面这段文字做「' + t.label + '」，只输出处理后的结果：\n\n');
  return [
    { role: 'system', content: t.sys },
    { role: 'user', content: ask + text }
  ];
}

/** 未登录用户按 IP 限量：只存哈希，不落原始 IP */
async function anonId(request, env) {
  const ip = String(request.headers.get('cf-connecting-ip') || '').split(',')[0].trim();
  if (!ip) return 'ip:none';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ivy-ai-ip|' + ip + '|' + (env.IVY_SECRET || '')));
  const hex = Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'ip:' + hex;
}

async function handle({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (!env.DB) return json({ error: '还没绑定 D1 数据库' }, 503);

  const sites = siteProviders(env);

  // 前端开面板时先问一次：站内有哪些免费模型、每天能用几次（不含任何密钥）
  if (request.method === 'GET') {
    const list = publicProviders(env);
    return json({
      ok: true,
      providers: list,
      defaultProvider: (list[0] && list[0].id) || '',
      custom: true,
      limits: { anon: quotaLimit(env, 'anon'), user: quotaLimit(env, 'user') }
    });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const body = await request.json().catch(() => ({}));
  const task = String(body.task || 'chat');
  if (!TASKS[task]) return json({ error: '不认识的 AI 动作' }, 400);

  const user = await currentUser(request, env);
  let provider = String(body.provider || '').trim();
  let backend;

  if (provider === 'custom' || (!provider && !sites.length)) {
    // 自己的接口：必须登录，配置来自 /api/ai-config
    if (!user) return json({ error: '用自己的接口要先登录', code: 'login' }, 401);
    let cfg;
    try { cfg = await loadAiConfig(env, user.uid); }
    catch (e) { return json({ error: String((e && e.message) || e).slice(0, 160) }, 500); }
    if (!cfg || !cfg.baseUrl || !cfg.model || !cfg.key) {
      return json({ error: '还没有配置自己的 AI 接口', code: 'ai-config-missing' }, 409);
    }
    if (cfg.broken) {
      return json({ error: '密钥解不开了（服务端密钥改过？），请在设置里重新填一次', code: 'ai-config-missing' }, 409);
    }
    const block = baseBlockReason(cfg.baseUrl);
    if (block) return json({ error: block }, 400);
    backend = { id: 'custom', name: '我的接口', baseUrl: cfg.baseUrl, model: cfg.model, key: cfg.key, extra: null };
  } else {
    if (!provider) provider = sites[0].id;
    backend = sites.find((p) => p.id === provider);
    if (!backend) return json({ error: '这个模型现在不可用，换一个试试', code: 'provider' }, 400);

    // 站内 key：登录按账号、未登录按 IP，每天各一份额度
    const who = user ? user.uid : await anonId(request, env);
    const limit = quotaLimit(env, user ? 'user' : 'anon');
    const q = await takeQuota(env, who, 'ai', limit);
    if (!q.ok) {
      return json({
        error: `今天的免费额度用完了（每天 ${limit} 次），明天再来；也可以登录后在「AI 接口设置」里填自己的接口，不限次`,
        code: 'quota', limit, used: q.used
      }, 429);
    }
  }

  const messages = buildMessages(task, body);
  if (!messages) return json({ error: task === 'chat' ? '没有可发送的内容' : '没有可处理的内容' }, 400);

  const t = TASKS[task];
  const payload = Object.assign({
    model: backend.model,
    messages,
    stream: true,
    temperature: t.temperature,
    max_tokens: t.max
  }, backend.extra || {});

  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 180000);

  const callUpstream = (model) => fetch(backend.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + backend.key,
      accept: 'text/event-stream'
    },
    body: JSON.stringify(Object.assign({}, payload, { model })),
    signal: ctl.signal
  });

  let model = backend.model;
  let r;
  try {
    r = await callUpstream(model);
    // 站内免费模型容易遇到「当前访问量过大」：换一个同家的备用模型再试一次
    if (!r.ok && backend.fallback && backend.fallback !== model && (r.status === 429 || r.status === 503)) {
      try { await r.body.cancel(); } catch (e) {}
      model = backend.fallback;
      r = await callUpstream(model);
    }
  } catch (e) {
    clearTimeout(timer);
    const msg = String((e && e.message) || e);
    return json({ error: /abort/i.test(msg) ? '接口响应超时' : ('连不上接口：' + msg.slice(0, 150)) }, 424);
  }

  if (!r.ok) {
    clearTimeout(timer);
    const raw = await r.text().catch(() => '');
    let detail = raw;
    try {
      const j = JSON.parse(raw);
      detail = (j.error && (j.error.message || j.error)) || j.message || raw;
    } catch (e) { /* 保持原文 */ }
    return json({ error: providerMessage(r.status, detail), code: 'provider', model }, 424);
  }

  const headers = Object.assign(textHeaders(model), { 'x-ai-provider': encodeURIComponent(backend.id) });
  const ctype = String(r.headers.get('content-type') || '');
  // 少数网关无视 stream:true，直接回一整块 JSON —— 兜住它，别让前端看到空白
  if (ctype.indexOf('application/json') >= 0) {
    const j = await r.json().catch(() => ({}));
    clearTimeout(timer);
    const text = contentOf(j);
    if (!text) return json({ error: '模型没有返回内容' }, 424);
    return new Response(text, { headers });
  }

  const stream = streamText(r.body);
  const wrapped = stream.pipeThrough(new TransformStream({
    flush() { clearTimeout(timer); }
  }));
  return new Response(wrapped, { headers });
}

// 兜底：任何未捕获的异常都转成 JSON，别让用户看到 Cloudflare 的 502 白页
export async function onRequest(ctx) {
  try {
    return await handle(ctx);
  } catch (e) {
    return json({ error: 'AI 服务内部错误：' + String((e && e.stack) || e).slice(0, 300) }, 500);
  }
}
