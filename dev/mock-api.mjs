/**
 * 本地 Mock 上游 —— 不花一分 token 就能调试前端
 *
 * 目的：完整复刻「全家桶应用 API」的响应形状（含 SSE 事件序列、内容块、
 * 引用、usage），让渲染层可以在没有真实 Key 的情况下被验证。
 *
 * 用法：
 *   node dev/mock-api.mjs                 # 监听 8899
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:8899 PORT=8787 node server.mjs
 */

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8899);

const SOURCES = [
  {
    title: 'DeepSeek 发布全家桶应用 API｜DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/zh-cn/news/news261113/',
    snippet:
      '今天，我们正式开放这套全家桶应用 API：在原有 API 中开启对应参数，即可获得深度思考搜索、文件输入等对话功能。',
    site_name: 'DeepSeek',
    site_icon: 'https://cdn.deepseek.com/site-icons/deepseek.com',
  },
  {
    title: 'DeepSeek 开放“全家桶”应用 API，开发者可 1:1 复刻完整 App',
    url: 'https://www.163.com/dy/article/LBLAGNHH05198CJN.html',
    snippet:
      '搜索、文件、链接、安全、语音等能力全部通过 API 开放，开发者可以省去对接外部工具的衔接成本。',
    site_name: '网易',
    site_icon: null,
  },
  {
    title: '构建 Chatbot｜DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/zh-cn/guides/build_a_chatbot',
    snippet:
      '搜索和阅读链接都由服务端完成。客户端只需要展示返回的内容块，并在下一轮把它们原样回传。',
    site_name: 'DeepSeek',
    site_icon: 'https://cdn.deepseek.com/site-icons/deepseek.com',
  },
];

const ANSWER = `这套 API 的关键变化，是把 DeepSeek App 里的能力**下放成了参数**，而不是让开发者自己拼工具链。

## 三个层次

1. **对话内建工具**：声明 \`deepseek_web_search\` 就能联网；开启思考后同一次声明自动变成「深度思考搜索」，模型会在多步推理里自己搜索、打开网页、页内查找。
2. **独立接口**：Search、Fetch、OCR、ASR、TTS 都能单独调用，方便接进已有工作流。
3. **服务端托管**：工具调用与上下文拼接都在服务端完成，客户端只要渲染内容块，并在下一轮原样回传。

## 工程上省掉的事

| 以前要做 | 现在 |
| --- | --- |
| 自己接搜索 API、做 query 改写 | 声明工具，模型自己发起多查询词搜索 |
| 自己抓网页、清洗正文 | \`deepseek_read_url\` 自动识别消息里的链接 |
| 自己解析 PDF / Office / 图片 | 上传 \`/files\` 拿 \`file_id\` 直接引用 |
| 自己做合规拦截 | \`safety_check.level = high\` |

> 注意：对外提供服务时，内容安全审核、大模型登记、AI 标识这些义务仍然是服务提供者自己的。

一个容易踩的点：用过联网工具的回复**不能续写**，要重发上一次请求。`;

/* ---------- SSE ---------- */

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamMessages(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const usage = {
    input_tokens: 1908,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 386,
    service_tier: 'standard',
    server_tool_use: {
      web_search_requests: 1,
      web_fetch_requests: 0,
      tool_search: 2,
      tool_fetch: 0,
      tool_image_search: 0,
    },
  };

  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: 'msg_mock_' + Date.now(),
      type: 'message',
      role: 'assistant',
      model: 'deepseek-flash',
      content: [],
      stop_reason: null,
      usage: { ...usage, output_tokens: 0 },
    },
  });

  // 1. thinking
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  });
  for (const chunk of ['用户想了解', '新开放的', '全家桶 API', '带来了什么变化。', '需要查官方文档。']) {
    await sleep(45);
    sse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: chunk },
    });
  }
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'sig_mock_abc123' },
  });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });

  // 2. search tool use
  const toolId = 'srvtoolu_s_00_mock0001';
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'server_tool_use',
      id: toolId,
      name: 'deepseek_web_search',
      input: { action: 'search', queries: ['DeepSeek 全家桶应用 API', 'deepseek_web_search 参数'] },
      caller: { type: 'direct' },
      kind: 'search',
    },
  });
  await sleep(60);
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 1 });

  // 3. search results
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 2,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: toolId,
      content: SOURCES.map((s, i) => ({
        type: 'web_search_result',
        title: s.title,
        url: s.url,
        encrypted_content: 'enc_' + i,
        page_age: '2026-11-13T08:00:00+00:00',
        snippet: s.snippet,
        site_name: s.site_name,
        site_icon: s.site_icon,
      })),
      kind: 'search',
    },
  });
  await sleep(40);
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 2 });

  // 4. text with citations — 分两段，各自带引用
  const part1 = ANSWER.slice(0, 200);
  const part2 = ANSWER.slice(200);

  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 3,
    content_block: { type: 'text', text: '' },
  });
  for (let i = 0; i < part1.length; i += 14) {
    await sleep(12);
    sse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'text_delta', text: part1.slice(i, i + 14) },
    });
  }
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 3,
    delta: {
      type: 'citations_delta',
      citation: {
        type: 'web_search_result_location',
        url: SOURCES[0].url,
        title: SOURCES[0].title,
        encrypted_index: '',
        cited_text: part1,
      },
    },
  });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 3 });

  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 4,
    content_block: { type: 'text', text: '' },
  });
  for (let i = 0; i < part2.length; i += 14) {
    await sleep(10);
    sse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 4,
      delta: { type: 'text_delta', text: part2.slice(i, i + 14) },
    });
  }
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 4,
    delta: {
      type: 'citations_delta',
      citation: {
        type: 'web_search_result_location',
        url: SOURCES[2].url,
        title: SOURCES[2].title,
        encrypted_index: '',
        cited_text: part2,
      },
    },
  });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 4 });

  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null, title: '全家桶 API 带来了什么' },
    usage,
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function streamRefusal(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  sse(res, 'message_start', {
    type: 'message_start',
    message: { id: 'msg_refusal', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [] },
  });
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '这里是一段已经流出的内容，' },
  });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: 'refusal',
      stop_sequence: null,
      stop_details: { type: 'refusal', category: null, explanation: null },
    },
    usage: { input_tokens: 32, output_tokens: 12, safety_tokens: 8 },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/* ---------- 其他端点 ---------- */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/anthropic/v1/messages' && req.method === 'POST') {
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      /* 忽略 */
    }
    const needle = JSON.stringify(body.messages || '');

    // 便于验证异常路径的两个特殊口令
    if (needle.includes('错误测试')) {
      return json(res, 500, {
        error: { message: 'mock：上游服务暂时不可用，请稍后重试', type: 'server_error' },
      });
    }
    if (needle.includes('拒答测试')) return streamRefusal(req, res);

    return streamMessages(req, res);
  }

  if (url.pathname === '/files' && req.method === 'POST') {
    await readBody(req);
    await sleep(400);
    return json(res, 200, {
      id: 'file-api-mock' + Date.now(),
      object: 'file',
      bytes: 1048576,
      created_at: Math.floor(Date.now() / 1000),
      filename: 'report.pdf',
      purpose: 'rich_layout_recognition',
    });
  }

  if (url.pathname === '/v1/tools/asr' && req.method === 'POST') {
    await readBody(req);
    return json(res, 200, { request_id: 'mock', text: '帮我调研一下这个新 API。', duration_ms: 2400 });
  }

  if (url.pathname === '/v1/tools/tts' && req.method === 'POST') {
    await readBody(req);
    // 0.6 秒 440Hz 正弦波，够验证播放链路
    const rate = 16000;
    const n = rate * 0.6;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
      buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': buf.length });
    return res.end(buf);
  }

  if (url.pathname === '/v1/tools/search' && req.method === 'POST') {
    await readBody(req);
    return json(res, 200, { results: SOURCES });
  }

  json(res, 404, { error: { message: `mock 未实现 ${req.method} ${url.pathname}` } });
});

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`  mock 上游已启动 → http://127.0.0.1:${PORT}`);
  console.log(`  用法：DEEPSEEK_BASE_URL=http://127.0.0.1:${PORT} node server.mjs`);
});
