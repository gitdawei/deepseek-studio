/**
 * DeepSeek Studio — 前端主逻辑
 *
 * 依赖：/md.js（window.DSMarkdown）
 * 上游：/api/* 由 server.mjs 代理到 https://api.deepseek.com/*
 *
 * 关键约定（对应「全家桶应用 API」文档）：
 *   - Messages API 只认 deepseek-flash
 *   - 搜索结果 / 思考 / 工具块必须在下一轮原样回传（保留 kind 与 signature）
 *   - safety_check 命中拒答时 stop_reason === 'refusal'，已流出的文本无法撤回
 *   - /files 上传必须先 purpose 后 file，解析完成才返回 file_id
 */

(function () {
  'use strict';

  const { render: mdRender, escapeHtml } = window.DSMarkdown;

  /* ══════════════════════ 常量与工具 ══════════════════════ */

  const STORAGE_KEY = 'deepseek-studio:v1';
  const MODEL = 'deepseek-flash';
  const MAX_TOKENS = 8192;

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  const now = () => Date.now();

  const fmtTime = (ts) =>
    new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  const fmtNum = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n ?? 0));

  function toast(msg, ms = 2400) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), ms);
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  const ICON = {
    chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    spinner: '<svg viewBox="0 0 24 24" class="spin"><path d="M12 3a9 9 0 109 9" /></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.5.5l2-2a5 5 0 00-7-7L11 6"/><path d="M14 11a5 5 0 00-7.5-.5l-2 2a5 5 0 007 7L13 18"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M14 3v5h5"/><path d="M14 3H6v18h12V8z"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
    speak: '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 010 6M19 6a8 8 0 010 12"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    pencil: '<svg viewBox="0 0 24 24"><path d="M4 20h4L20 8l-4-4L4 16z"/></svg>',
  };

  /* ══════════════════════ 状态 ══════════════════════ */

  const defaultSettings = {
    apiKey: '',
    model: MODEL,
    thinking: false,
    webSearch: true,
    readUrl: true,
    safety: 'high',
    title: 'on',
    theme: 'dark',
    parsing: 'rich', // rich_layout_recognition | text_recognition
    voice: 'stella', // stella | tide
    location: '上海',
    lang: '中文',
    sidebarCollapsed: false,
    sourcesOpen: false,
  };

  let state = {
    conversations: [],
    activeId: null,
    settings: { ...defaultSettings },
    abort: null,
    streaming: false,
    serverKey: false,
    apiBase: '/api', // '/api' = 同源代理；'https://api.deepseek.com' = 浏览器直连
    pending: [], // 待上传附件
    pinned: true, // 视图是否锚定在底部
  };

  function save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          conversations: state.conversations,
          activeId: state.activeId,
          settings: state.settings,
        }),
      );
    } catch (e) {
      console.warn('保存失败', e);
      toast('本地存储空间不足，历史未保存');
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.conversations)) state.conversations = data.conversations;
      if (data.activeId) state.activeId = data.activeId;
      if (data.settings) state.settings = { ...defaultSettings, ...data.settings };
    } catch (e) {
      console.warn('读取失败', e);
    }
  }

  const activeConv = () => state.conversations.find((c) => c.id === state.activeId) || null;

  function newConversation() {
    const conv = { id: uid(), title: '新对话', createdAt: now(), updatedAt: now(), messages: [] };
    state.conversations.unshift(conv);
    state.activeId = conv.id;
    save();
    renderConvList();
    renderChat();
    return conv;
  }

  /* ══════════════════════ 请求构造 ══════════════════════ */

  /**
   * 静态部署时没有 Node 代理，浏览器直接打 api.deepseek.com。
   * 该域名的 CORS 允许 content-type / authorization / x-api-key / anthropic-beta，
   * 所以同一份前端既能在 `node server.mjs` 下走代理，也能纯静态托管。
   */
  function apiUrl(path) {
    return `${state.apiBase}/${String(path).replace(/^\//, '')}`;
  }

  /** true = 浏览器直连官方域名；false = 走同源 /api 代理 */
  function isDirect() {
    return state.apiBase.startsWith('http');
  }

  async function detectMode() {
    if (window.DS_CONFIG && typeof window.DS_CONFIG.apiBase === 'string') {
      state.apiBase = window.DS_CONFIG.apiBase.replace(/\/$/, '') || '/api';
      return 'config';
    }
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('application/json')) {
        const data = await res.json();
        if (data?.ok) {
          state.apiBase = '/api';
          state.serverKey = Boolean(data.serverKey);
          return 'proxy';
        }
      }
    } catch {
      /* 静态托管下没有这个端点，属预期 */
    }
    state.apiBase = 'https://api.deepseek.com';
    return 'direct';
  }

  function authHeaders() {
    const h = {};
    const k = (state.settings.apiKey || '').trim();
    if (k) {
      h['x-api-key'] = k;
      h.authorization = `Bearer ${k}`;
    }
    return h;
  }

  /** 只保留协议认识的字段，避免把 UI 元数据发给服务端 */
  const BLOCK_KEYS = {
    thinking: ['type', 'thinking', 'signature'],
    text: ['type', 'text', 'citations'],
    server_tool_use: ['type', 'id', 'name', 'input', 'caller', 'kind'],
    web_search_tool_result: ['type', 'tool_use_id', 'content', 'kind'],
    web_fetch_tool_result: ['type', 'tool_use_id', 'content', 'kind', 'signature'],
    document: ['type', 'source'],
    image: ['type', 'source'],
    tool_use: ['type', 'id', 'name', 'input'],
    tool_result: ['type', 'tool_use_id', 'content', 'is_error'],
  };

  function cleanBlock(b) {
    const keys = BLOCK_KEYS[b.type];
    if (!keys) return null;
    const out = {};
    for (const k of keys) if (b[k] !== undefined) out[k] = b[k];
    return out;
  }

  function toWire(messages) {
    const out = [];
    for (const m of messages) {
      if (m.role === 'latest_reminder') {
        out.push({ role: 'latest_reminder', content: m.content });
        continue;
      }
      if (typeof m.content === 'string') {
        out.push({ role: m.role, content: m.content });
        continue;
      }
      const content = (m.content || []).map(cleanBlock).filter(Boolean);
      if (content.length) out.push({ role: m.role, content });
    }
    return out;
  }

  function reminderLine() {
    const d = new Date();
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const loc = (state.settings.location || '').trim();
    return `${date},${weekdays[d.getDay()]},${loc},Web,${state.settings.lang || '中文'}`;
  }

  function buildBody(messages, opts = {}) {
    const s = state.settings;
    const body = {
      model: s.model || MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages,
    };
    if (opts.thinking ?? s.thinking) body.thinking = { type: 'enabled' };

    const tools = [];
    if (opts.webSearch ?? s.webSearch) tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' });
    if (opts.readUrl ?? s.readUrl) tools.push({ type: 'deepseek_read_url', name: 'deepseek_read_url' });
    if (tools.length) body.tools = tools;

    if ((opts.safety ?? s.safety) === 'high') body.safety_check = { level: 'high' };
    if (s.title === 'on') body.title = { enabled: true };

    return body;
  }

  /* ══════════════════════ SSE 解析 ══════════════════════ */

  async function* sseEvents(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let sep;
        // 事件之间用空行分隔，兼容 \r\n
        while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + (buf[sep] === '\r' ? 4 : 2));

          let event = 'message';
          const dataLines = [];
          for (const line of raw.split(/\r?\n/)) {
            if (line.startsWith(':')) continue; // keep-alive 注释
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          if (!dataLines.length) continue;
          const text = dataLines.join('\n');
          if (text === '[DONE]') return;
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            continue;
          }
          yield { event, data };
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  }

  /* ══════════════════════ 来源注册表 ══════════════════════ */

  function buildRegistry(conv) {
    const list = [];
    const index = new Map();

    const add = (item) => {
      const key = item.url || 'title:' + (item.title || '');
      if (!key) return;
      if (index.has(key)) return;
      index.set(key, list.length + 1);
      list.push({ ...item, n: list.length + 1 });
    };

    for (const m of conv?.messages || []) {
      if (m.role !== 'assistant') continue;
      for (const b of m.content || []) {
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
          for (const r of b.content) {
            if (r && r.url) {
              add({
                url: r.url,
                title: r.title || r.url,
                site: r.site_name,
                icon: r.site_icon,
                snippet: r.snippet,
                via: 'search',
              });
            }
          }
        } else if (b.type === 'web_fetch_tool_result') {
          const c = b.content;
          if (c?.type === 'web_fetch_result' && c.url) {
            add({
              url: c.url,
              title: c.content?.title || c.url,
              site: c.url.replace(/^https?:\/\//, '').split('/')[0],
              via: b.kind === 'read_link' ? 'read' : 'deep',
            });
          }
        } else if (b.type === 'text' && Array.isArray(b.citations)) {
          for (const c of b.citations) {
            if (!c?.url) continue;
            add({ url: c.url, title: c.title || c.url, site: hostOf(c.url), via: 'cite' });
          }
        }
      }
    }
    return { list, index };
  }

  const hostOf = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return u;
    }
  };

  /* ══════════════════════ 块渲染 ══════════════════════ */

  const TOOL_META = {
    search: { label: '联网搜索', icon: ICON.search, dot: 'search' },
    deep_search: { label: '深度思考搜索', icon: ICON.globe, dot: 'deep' },
    read_link: { label: '阅读链接', icon: ICON.link, dot: 'read' },
    image_search: { label: '图片搜索', icon: ICON.globe, dot: 'image' },
    deep_image_search: { label: '图片搜索', icon: ICON.globe, dot: 'image' },
  };

  function toolMetaFor(block) {
    const kind = block.kind || (block.input?.action === 'read_link' ? 'read_link' : 'search');
    const base = TOOL_META[kind] || TOOL_META.search;
    if (kind === 'deep_search' && block.input?.action === 'open_page') {
      return { label: '打开网页', icon: ICON.link, dot: 'deep' };
    }
    if (kind === 'deep_search' && block.input?.action === 'find_in_page') {
      return { label: '页内查找', icon: ICON.search, dot: 'deep' };
    }
    return base;
  }

  function toolSubline(block) {
    const a = block.input?.action;
    if (a === 'search') return `${(block.input.queries || []).length} 个查询词`;
    if (a === 'open_page' || a === 'read_link') return hostOf(block.input.url || '');
    if (a === 'find_in_page') return `查找「${block.input.pattern || ''}」`;
    return '';
  }

  function createToolCard(block) {
    const meta = toolMetaFor(block);
    const card = el('div', 'tool-card');
    const head = el('div', 'tool-head');
    head.innerHTML =
      `<span class="t-ico">${meta.icon}</span>` +
      `<span class="t-title">${escapeHtml(meta.label)}</span>` +
      `<span class="t-sub">${escapeHtml(toolSubline(block))}</span>`;
    card.appendChild(head);

    if (block.input?.action === 'search' && Array.isArray(block.input.queries) && block.input.queries.length) {
      const chips = el('div', 'qchips');
      chips.innerHTML = block.input.queries
        .map((q) => `<span class="qchip">${escapeHtml(q)}</span>`)
        .join('');
      card.appendChild(chips);
    }
    if (block.input?.url && block.input.action !== 'search') {
      const u = el('div', 'qchips');
      u.innerHTML = `<a class="qchip" href="${escapeHtml(block.input.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        block.input.url,
      )}</a>`;
      card.appendChild(u);
    }
    card._results = el('div', 'results');
    card.appendChild(card._results);
    return card;
  }

  function renderSearchResults(card, block) {
    const list = card._results;
    const items = Array.isArray(block.content) ? block.content : [];

    if (!items.length) {
      list.innerHTML = `<div class="result"><div class="result-txt"><div class="rt-site">没有返回结果</div></div></div>`;
      return;
    }
    if (items[0]?.type === 'web_search_tool_result_error') {
      list.innerHTML = `<div class="result"><div class="result-txt"><div class="rt-site">搜索失败（${escapeHtml(
        items[0].error_code || 'unknown',
      )}）</div></div></div>`;
      return;
    }

    list.innerHTML = items
      .map((r) => {
        if (!r?.url) return '';
        const icon = r.site_icon
          ? `<img src="${escapeHtml(r.site_icon)}" alt="" onerror="this.remove()">`
          : escapeHtml((r.site_name || hostOf(r.url) || '?').slice(0, 1).toUpperCase());
        return (
          `<a class="result" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">` +
          `<span class="fav">${icon}</span>` +
          `<span class="result-txt">` +
          `<span class="rt-title">${escapeHtml(r.title || r.url)}</span>` +
          (r.snippet ? `<span class="rt-snip">${escapeHtml(r.snippet)}</span>` : '') +
          `<span class="rt-site">${escapeHtml(r.site_name || hostOf(r.url))}${
            r.page_age ? ' · ' + escapeHtml(String(r.page_age).slice(0, 10)) : ''
          }</span>` +
          `</span></a>`
        );
      })
      .join('');

    const head = card.querySelector('.t-sub');
    if (head) head.textContent = `${items.length} 条结果`;
  }

  function renderFetchResult(card, block) {
    const c = block.content || {};
    card.classList.add('fetch-card');
    const list = card._results;
    if (c.type === 'web_fetch_tool_result_error') {
      list.innerHTML = `<div class="result"><div class="result-txt"><div class="rt-site">抓取失败（${escapeHtml(
        c.error_code || 'unknown',
      )}）</div></div></div>`;
      return;
    }
    const title = c.content?.title || c.url || '';
    list.innerHTML =
      `<a class="result" href="${escapeHtml(c.url || '#')}" target="_blank" rel="noopener noreferrer">` +
      `<span class="fav">${ICON.link}</span>` +
      `<span class="result-txt">` +
      `<span class="rt-title">${escapeHtml(title)}</span>` +
      `<span class="rt-site">${escapeHtml(hostOf(c.url || ''))}${
        c.published_at ? ' · ' + escapeHtml(String(c.published_at).slice(0, 10)) : ''
      }</span>` +
      `</span></a>`;
    const head = card.querySelector('.t-sub');
    if (head) head.textContent = '已读取';
  }

  function textWithCitations(block, registry) {
    let text = block.text || '';
    const cites = Array.isArray(block.citations) ? block.citations : [];
    if (!cites.length) return text;

    const groups = new Map(); // pos -> [n]
    for (const c of cites) {
      const n = registry.index.get(c.url);
      if (!n) continue;
      let pos = text.length;
      if (c.cited_text && text.startsWith(c.cited_text)) pos = c.cited_text.length;
      if (!groups.has(pos)) groups.set(pos, []);
      const arr = groups.get(pos);
      if (!arr.includes(n)) arr.push(n);
    }
    if (!groups.size) return text;

    const positions = [...groups.keys()].sort((a, b) => a - b);
    let out = '';
    let last = 0;
    for (const pos of positions) {
      out += text.slice(last, pos);
      out += groups
        .get(pos)
        .map((n) => `{{CIT:${n}}}`)
        .join('');
      last = pos;
    }
    out += text.slice(last);
    return out;
  }

  /**
   * 渲染一段连续正文。
   *
   * 文档明确：一个 text 块带上引用后，之后的正文会另起一个新的 text 块。
   * 也就是说同一个回答常由多个相邻 text 块拼成，若逐块渲染，列表和表格会被
   * 拦腰截断。因此这里把相邻 text 块拼成一份完整 Markdown 再渲染。
   */
  function renderAnswerText(node, blocks, registry) {
    let src = '';
    for (const b of blocks) src += textWithCitations(b, registry);
    let html = mdRender(src);
    html = html.replace(
      /\{\{CIT:(\d+)\}\}/g,
      (_, n) => `<sup class="cite" data-src="${n}" title="查看来源 ${n}">${n}</sup>`,
    );
    node.innerHTML = html;
  }

  /**
   * 创建内容块对应的 DOM。
   * @returns {{node: HTMLElement|null, append?:Function, finish?:Function}}
   */
  function createBlock(block, ctx) {
    // 遇到非正文块就切断「连续正文」分组
    if (block.type !== 'text') ctx.answer = null;

    switch (block.type) {
      case 'thinking': {
        const wrap = el('details', 'think');
        wrap.open = true;
        wrap.innerHTML =
          `<summary class="think-head"><span class="chev">${ICON.chevron}</span>` +
          `<span class="spin">${ICON.spinner}</span><span class="tlabel">深度思考中…</span></summary>` +
          `<div class="think-body"></div>`;
        const body = wrap.querySelector('.think-body');
        wrap._start = now();
        return {
          node: wrap,
          append(delta) {
            if (delta.thinking) {
              body.textContent += delta.thinking;
              body.scrollTop = body.scrollHeight;
            }
          },
          finish() {
            const secs = Math.max(1, Math.round((now() - wrap._start) / 1000));
            wrap.querySelector('.spin')?.remove();
            const label = wrap.querySelector('.tlabel');
            if (!body.textContent.trim()) {
              label.textContent = '已深度思考';
              body.textContent = '（本次思考未产生可见内容）';
            } else {
              label.textContent = `已深度思考（用时 ${secs} 秒）`;
            }
            wrap.open = false;
          },
        };
      }

      case 'text': {
        // 相邻 text 块复用同一个 .answer 容器，拼成一份 Markdown
        let group = ctx.answer;
        let reused = true;
        if (!group) {
          const node = el('div', 'answer caret');
          group = { node, blocks: [], queued: false };
          group.paint = () => {
            group.queued = false;
            renderAnswerText(node, group.blocks, ctx.registry());
          };
          group.schedule = () => {
            if (group.queued) return;
            group.queued = true;
            requestAnimationFrame(() => group.paint());
          };
          ctx.answer = group;
          reused = false;
        }
        group.blocks.push(block);
        return {
          node: group.node,
          reused,
          append(delta) {
            if (delta.text) {
              block.text = (block.text || '') + delta.text;
              group.schedule();
            }
            if (delta.citation) {
              (block.citations = block.citations || []).push(delta.citation);
              group.schedule();
            }
          },
          finish() {
            group.paint();
          },
        };
      }

      case 'server_tool_use': {
        const card = createToolCard(block);
        ctx.cards.set(block.id, card);
        ctx.trace.push({ kind: block.kind, action: block.input?.action, block });
        return { node: card };
      }

      case 'web_search_tool_result': {
        const card = ctx.cards.get(block.tool_use_id);
        if (card) {
          renderSearchResults(card, block);
          return { node: null };
        }
        const solo = el('div', 'tool-card');
        solo.innerHTML = `<div class="tool-head"><span class="t-ico">${ICON.search}</span><span class="t-title">搜索结果</span></div>`;
        solo._results = el('div', 'results');
        solo.appendChild(solo._results);
        renderSearchResults(solo, block);
        return { node: solo };
      }

      case 'web_fetch_tool_result': {
        const card = ctx.cards.get(block.tool_use_id);
        if (card) {
          renderFetchResult(card, block);
          return { node: null };
        }
        const solo = el('div', 'tool-card');
        solo.innerHTML = `<div class="tool-head"><span class="t-ico">${ICON.link}</span><span class="t-title">网页内容</span></div>`;
        solo._results = el('div', 'results');
        solo.appendChild(solo._results);
        renderFetchResult(solo, block);
        return { node: solo };
      }

      default:
        return { node: null };
    }
  }

  /* ══════════════════════ 消息渲染 ══════════════════════ */

  function userFiles(msg) {
    return msg._ui?.files || [];
  }

  function renderUserMessage(msg) {
    const wrap = el('div', 'msg msg-user');
    const bubble = el('div', 'bubble');

    const files = userFiles(msg);
    if (files.length) {
      const box = el('div', 'attachments');
      box.style.padding = '0 0 6px';
      box.innerHTML = files
        .map(
          (f) =>
            `<span class="att done"><span class="a-ico">${fileIcon(f.name)}</span>` +
            `<span class="a-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span></span>`,
        )
        .join('');
      bubble.appendChild(box);
    }

    const textNode = el('div');
    textNode.innerHTML = escapeHtml(msg.text || '').replace(
      /(https?:\/\/[^\s<]+)/g,
      (u) =>
        `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a>`,
    );
    bubble.appendChild(textNode);
    wrap.appendChild(bubble);
    return wrap;
  }

  function fileIcon(name = '') {
    const ext = name.split('.').pop().toLowerCase();
    if (['pdf'].includes(ext)) return '📕';
    if (['doc', 'docx'].includes(ext)) return '📘';
    if (['ppt', 'pptx'].includes(ext)) return '📙';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'].includes(ext)) return '🖼️';
    return '📄';
  }

  function renderAssistantMessage(msg, conv) {
    const wrap = el('div', 'msg msg-assistant');

    const meta = el('div', 'msg-meta');
    meta.innerHTML =
      `<span class="avatar">✦</span><span class="name">DeepSeek</span>` +
      `<span class="ts">${fmtTime(msg.createdAt || now())}</span>`;
    wrap.appendChild(meta);

    const body = el('div', 'msg-body');
    wrap.appendChild(body);

    const registry = () => buildRegistry(conv);
    const ctx = { registry, cards: new Map(), trace: [] };

    for (const block of msg.content || []) {
      const { node, finish, reused } = createBlock(block, ctx);
      if (node && !reused) body.appendChild(node);
      finish?.();
    }
    body.querySelectorAll('.answer.caret').forEach((n) => n.classList.remove('caret'));

    if (msg.meta?.refusal) body.appendChild(refusalBanner(msg.meta.refusalText));
    else if (msg.meta?.error) body.appendChild(errorBox(msg.meta.error));

    wrap.appendChild(buildActions(msg, conv, body));

    if (msg.meta?.usage) wrap.appendChild(usageLine(msg.meta.usage));
    return wrap;
  }

  function refusalBanner(text) {
    const n = el('div', 'refusal');
    n.innerHTML = `${ICON.warn}<div><strong>内容已被安全审核拦截</strong><br>${escapeHtml(
      text || '模型输出了不符合内容安全策略的内容，已按拒答处理。',
    )}</div>`;
    return n;
  }

  function errorBox(text) {
    const n = el('div', 'error-box');
    n.innerHTML = `<strong>请求失败</strong>${escapeHtml(text)}`;
    return n;
  }

  function usageLine(u) {
    const parts = [];
    parts.push(`输入 ${fmtNum(u.input_tokens)} tokens`);
    if (u.cache_read_input_tokens) parts.push(`缓存命中 ${fmtNum(u.cache_read_input_tokens)}`);
    parts.push(`输出 ${fmtNum(u.output_tokens)} tokens`);
    const st = u.server_tool_use || {};
    if (st.tool_search) parts.push(`搜索 ${st.tool_search} 次`);
    if (st.tool_fetch) parts.push(`抓取 ${st.tool_fetch} 次`);
    if (st.tool_image_search) parts.push(`图片搜索 ${st.tool_image_search} 次`);
    if (u.output_tokens_details?.safety_tokens) parts.push(`安全审核 ${u.output_tokens_details.safety_tokens}`);
    const n = el('div', 'usage-line');
    n.textContent = parts.join('  ·  ');
    return n;
  }

  function answerPlainText(msg) {
    return (msg.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('\n')
      .trim();
  }

  function buildActions(msg, conv, body) {
    const bar = el('div', 'msg-actions');

    const copy = el('button', null, `${ICON.copy}<span>复制</span>`);
    copy.onclick = async () => {
      const t = answerPlainText(msg);
      if (!t) return;
      await navigator.clipboard.writeText(t);
      toast('已复制');
    };
    bar.appendChild(copy);

    const speak = el('button', null, `${ICON.speak}<span>朗读</span>`);
    speak.onclick = () => speakText(answerPlainText(msg), speak);
    bar.appendChild(speak);

    const regen = el('button', null, `${ICON.refresh}<span>重新生成</span>`);
    regen.onclick = () => regenerate(msg, conv);
    bar.appendChild(regen);

    if (msg.meta?.stop_reason === 'max_tokens') {
      const hint = el('span');
      hint.style.cssText = 'font-size:11px;color:var(--muted);align-self:center;padding-left:6px';
      hint.textContent = '已达长度上限';
      bar.appendChild(hint);
    }
    return bar;
  }

  function renderChat() {
    const conv = activeConv();
    const msgs = $('#messages');
    msgs.innerHTML = '';

    if (!conv || !conv.messages.length) {
      $('#empty').style.display = '';
      msgs.style.display = 'none';
      $('#topbarTitle').textContent = conv?.title || '新对话';
      renderSources();
      return;
    }

    $('#empty').style.display = 'none';
    msgs.style.display = '';
    $('#topbarTitle').textContent = conv.title || '新对话';

    for (const m of conv.messages) {
      msgs.appendChild(m.role === 'user' ? renderUserMessage(m) : renderAssistantMessage(m, conv));
    }
    renderSources();
    scrollToBottom(true);
  }

  /**
   * 滚动锚定：只有用户停留在底部时才跟随新内容。
   *
   * 难点在于程序化滚动也会触发 scroll 事件，若直接用「距底部距离」判断，
   * 内容增长后的那次回调会被误判成用户上翻。因此记录上次自动滚动到的位置，
   * scrollTop 与它一致就视为程序化滚动并忽略。
   */
  let lastAutoScroll = -1;

  function scrollToBottom(force = false) {
    const sc = $('#chatScroll');
    if (force) state.pinned = true;
    if (!state.pinned) return;
    sc.scrollTop = sc.scrollHeight;
    lastAutoScroll = sc.scrollTop;
  }

  /* ══════════════════════ 会话列表 ══════════════════════ */

  function renderConvList() {
    const list = $('#convList');
    list.innerHTML = '';
    for (const c of state.conversations) {
      const item = el('div', `conv-item${c.id === state.activeId ? ' active' : ''}`);
      item.innerHTML = `<span>${escapeHtml(c.title || '新对话')}</span>`;

      const acts = el('div', 'row-act');
      const rename = el('button', null, ICON.pencil);
      rename.title = '重命名';
      rename.onclick = (e) => {
        e.stopPropagation();
        const t = prompt('重命名对话', c.title);
        if (t != null && t.trim()) {
          c.title = t.trim();
          save();
          renderConvList();
          if (c.id === state.activeId) $('#topbarTitle').textContent = c.title;
        }
      };
      const del = el('button', null, ICON.trash);
      del.title = '删除';
      del.onclick = (e) => {
        e.stopPropagation();
        if (!confirm(`删除「${c.title}」？`)) return;
        state.conversations = state.conversations.filter((x) => x.id !== c.id);
        if (state.activeId === c.id) state.activeId = state.conversations[0]?.id || null;
        save();
        renderConvList();
        renderChat();
      };
      acts.append(rename, del);
      item.appendChild(acts);

      item.onclick = () => {
        state.activeId = c.id;
        save();
        renderConvList();
        renderChat();
        closeMobileSidebar();
      };
      list.appendChild(item);
    }
  }

  /* ══════════════════════ 溯源面板 ══════════════════════ */

  let sourceTab = 'sources';

  function renderSources() {
    const conv = activeConv();
    const reg = buildRegistry(conv);
    const body = $('#sourcesBody');
    $('#sourceCount').textContent = String(reg.list.length);

    if (sourceTab === 'sources') {
      if (!reg.list.length) {
        body.innerHTML = `<div class="empty-side">还没有来源。<br>打开「联网」或「读链接」后提问，<br>搜索与抓取结果会汇总到这里。</div>`;
        return;
      }
      body.innerHTML = reg.list
        .map(
          (s) =>
            `<a class="src-item" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">` +
            `<span class="src-idx">${s.n}</span>` +
            `<span style="min-width:0">` +
            `<div class="s-t">${escapeHtml(s.title || s.url)}</div>` +
            `<div class="s-u">${escapeHtml(hostOf(s.url))}</div>` +
            `<div class="s-n">${viaLabel(s.via)}${s.snippet ? ' · ' + escapeHtml(s.snippet.slice(0, 46)) + '…' : ''}</div>` +
            `</span></a>`,
        )
        .join('');
      return;
    }

    // 调用轨迹
    const trace = [];
    for (const m of conv?.messages || []) {
      if (m.role !== 'assistant') continue;
      for (const b of m.content || []) {
        if (b.type === 'server_tool_use') trace.push(b);
      }
    }
    if (!trace.length) {
      body.innerHTML = `<div class="empty-side">本次对话还没有工具调用。<br>模型会自行判断何时搜索或读链接。</div>`;
      return;
    }
    body.innerHTML = trace
      .map((b) => {
        const meta = toolMetaFor(b);
        const a = b.input?.action;
        const detail =
          a === 'search'
            ? (b.input.queries || []).join(' / ')
            : a === 'find_in_page'
              ? `${b.input.url} · 「${b.input.pattern}」`
              : b.input?.url || '';
        return (
          `<div class="trace-item"><span class="trace-dot ${meta.dot}"></span>` +
          `<div class="trace-body"><div class="tt">${escapeHtml(meta.label)}</div>` +
          `<div class="td">${escapeHtml(detail)}</div></div></div>`
        );
      })
      .join('');
  }

  const viaLabel = (via) =>
    ({ search: '搜索结果', deep: '深度搜索·打开网页', read: '阅读链接', cite: '正文引用' })[via] || '来源';

  /* ══════════════════════ 发送与流式 ══════════════════════ */

  async function send(text) {
    if (state.streaming) return;
    if (state.pending.some((f) => f.state === 'uploading')) {
      toast('文件还在解析中，稍等一下再发');
      return;
    }
    const content = (text ?? $('#input').value).trim();
    const files = state.pending.filter((f) => f.fileId);
    if (!content && !files.length) return;

    let conv = activeConv();
    if (!conv) conv = newConversation();

    // 用户消息
    const blocks = [];
    for (const f of files) {
      blocks.push({ type: 'document', source: { type: 'file', file_id: f.fileId } });
    }
    if (content) blocks.push({ type: 'text', text: content });

    const userMsg = {
      role: 'user',
      content: blocks,
      text: content,
      createdAt: now(),
      _ui: { files: files.map((f) => ({ name: f.name, fileId: f.fileId })) },
    };
    conv.messages.push(userMsg);

    if (conv.title === '新对话' || !conv.title) {
      conv.title = content.slice(0, 24) || files[0]?.name || '新对话';
    }
    conv.updatedAt = now();
    state.pending = [];
    $('#input').value = '';
    autoGrow();
    renderAttachments();
    save();
    renderConvList();
    renderChat();
    state.streaming = true;
    updateSendBtn();

    const assistant = { role: 'assistant', content: [], createdAt: now(), meta: { usage: null } };
    conv.messages.push(assistant);

    await runStream(conv, assistant);
  }

  async function runStream(conv, assistant) {
    const msgs = $('#messages');
    const registry = () => buildRegistry(conv);
    const ctx = { registry, cards: new Map(), trace: [] };

    /* 构建助手气泡 */
    const wrap = el('div', 'msg msg-assistant');
    wrap.innerHTML =
      `<div class="msg-meta"><span class="avatar">✦</span><span class="name">DeepSeek</span>` +
      `<span class="ts">${fmtTime(now())}</span></div>`;
    const body = el('div', 'msg-body');
    const status = el('div', 'status-pill');
    status.innerHTML = `<span class="pulse"></span><span class="stext">思考中…</span>`;
    body.appendChild(status);
    wrap.appendChild(body);
    msgs.appendChild(wrap);
    scrollToBottom(true);

    const setStatus = (t) => {
      const s = status.querySelector('.stext');
      if (s) s.textContent = t;
    };

    const wire = [];
    for (const m of conv.messages) {
      if (m === assistant) continue;
      if (m.role === 'user') {
        wire.push({ role: 'latest_reminder', content: reminderLine() });
      }
      wire.push(m);
    }

    const bodyObj = buildBody(toWire(wire));
    const hasDocs = wire.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'document'),
    );

    const headers = { 'content-type': 'application/json', ...authHeaders() };
    if (hasDocs) headers['anthropic-beta'] = 'files-api-2025-04-14';

    const ac = new AbortController();
    state.abort = ac;

    let nodeMap = [];
    let sawText = false;
    let failed = null;

    try {
      const res = await fetch(apiUrl('anthropic/v1/messages'), {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyObj),
        signal: ac.signal,
      });

      if (!res.ok) {
        const raw = await res.text();
        let msg = raw;
        try {
          const j = JSON.parse(raw);
          msg = j.error?.message || j.message || raw;
        } catch {
          /* 原样展示 */
        }
        throw new Error(`${res.status} · ${msg}`);
      }

      for await (const { event, data } of sseEvents(res)) {
        if (event === 'error' || data.type === 'error') {
          throw new Error(data.error?.message || '生成失败');
        }

        switch (data.type) {
          case 'message_start':
            assistant.id = data.message?.id;
            assistant.meta.usage = data.message?.usage || null;
            break;

          case 'content_block_start': {
            const block = JSON.parse(JSON.stringify(data.content_block));
            assistant.content[data.index] = block;
            const created = createBlock(block, ctx);
            if (created.node && !created.reused) {
              status.insertAdjacentElement('beforebegin', created.node);
            }
            nodeMap[data.index] = created;
            if (block.type === 'text') {
              sawText = true;
              status.style.display = 'none';
            } else if (block.type === 'web_search_tool_result') {
              setStatus('已获取搜索结果');
            } else if (block.type === 'web_fetch_tool_result') {
              setStatus('已读取网页');
            } else if (block.type === 'server_tool_use') {
              const m = toolMetaFor(block);
              setStatus(block.kind === 'deep_search' ? '深度思考中 · 正在联网…' : `正在${m.label}…`);
            } else if (block.type === 'thinking') {
              setStatus('深度思考中…');
            }
            scrollToBottom();
            break;
          }

          case 'content_block_delta': {
            const block = assistant.content[data.index];
            if (!block) break;
            const api = nodeMap[data.index];
            const d = data.delta || {};
            if (block.type === 'thinking' && d.thinking) {
              block.thinking = (block.thinking || '') + d.thinking;
            }
            if (block.type === 'thinking' && d.signature) block.signature = d.signature;
            if (block.type === 'text' && d.type === 'citations_delta' && d.citation) {
              (block.citations = block.citations || []).push(d.citation);
              renderSources();
            }
            api?.append?.(d);
            scrollToBottom();
            break;
          }

          case 'content_block_stop': {
            nodeMap[data.index]?.finish?.();
            break;
          }

          case 'message_delta': {
            const d = data.delta || {};
            assistant.meta.stop_reason = d.stop_reason;
            if (data.usage) assistant.meta.usage = data.usage;
            if (d.title && (!conv.title || conv.title === '新对话' || conv.autoTitle)) {
              conv.title = d.title;
              conv.autoTitle = true;
              $('#topbarTitle').textContent = d.title;
              renderConvList();
            }
            if (d.stop_reason === 'refusal') assistant.meta.refusal = true;
            break;
          }

          case 'message_stop':
            break;

          default:
            break;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        assistant.meta.aborted = true;
      } else {
        failed = err.message || String(err);
      }
    } finally {
      state.abort = null;
      state.streaming = false;
      updateSendBtn();
      status.remove();
      body.querySelectorAll('.answer.caret').forEach((n) => n.classList.remove('caret'));
      if (failed) {
        assistant.meta.error = failed;
        body.appendChild(errorBox(failed));
      }
      if (assistant.meta.refusal) {
        // 已流出的文本无法撤回，按文档要求替换为拒答文案
        for (const n of $$('.answer', body)) n.remove();
        for (const n of $$('.think', body)) n.remove();
        body.appendChild(refusalBanner());
        assistant.meta.refusalText = '模型输出了不符合内容安全策略的内容，已按拒答处理。';
      }
      if (assistant.meta.usage && sawText) wrap.appendChild(usageLine(assistant.meta.usage));
      wrap.appendChild(buildActions(assistant, conv, body));
      conv.updatedAt = now();
      save();
      renderSources();
      scrollToBottom();
    }
  }

  async function regenerate(msg, conv) {
    if (state.streaming) return;
    const idx = conv.messages.indexOf(msg);
    if (idx < 0) return;
    // 移除这条助手回复及其后的内容
    conv.messages = conv.messages.slice(0, idx);
    save();
    renderChat();

    const assistant = { role: 'assistant', content: [], createdAt: now(), meta: {} };
    conv.messages.push(assistant);
    state.streaming = true;
    updateSendBtn();
    await runStream(conv, assistant);
  }

  /* ══════════════════════ 文件上传 ══════════════════════ */

  const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'tif'];
  const DATA_EXT = ['txt', 'md', 'csv', 'json', 'js', 'ts', 'py', 'html', 'css', 'xml', 'yaml', 'yml', 'xlsx', 'xls', 'epub', 'mobi'];

  function pickPurpose(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (DATA_EXT.includes(ext)) return 'user_data';
    if (IMG_EXT.includes(ext)) return 'rich_layout_recognition';
    return state.settings.parsing === 'rich' ? 'rich_layout_recognition' : 'text_recognition';
  }

  async function uploadFiles(fileList) {
    for (const file of fileList) {
      const item = {
        id: uid(),
        name: file.name,
        size: file.size,
        state: 'uploading',
        purpose: pickPurpose(file),
        fileId: null,
      };
      state.pending.push(item);
      renderAttachments();

      const fd = new FormData();
      // purpose 必须在 file 之前，否则 400
      fd.append('purpose', item.purpose);
      fd.append('file', file, file.name);

      try {
        const res = await fetch(apiUrl('files'), {
          method: 'POST',
          headers: authHeaders(),
          body: fd,
        });
        const raw = await res.text();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(raw.slice(0, 200));
        }
        if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
        item.state = 'done';
        item.fileId = data.id;
        item.pages = data.page_count;
      } catch (err) {
        item.state = 'failed';
        item.error = err.message;
        toast(`「${file.name}」上传失败：${err.message}`, 4000);
      }
      renderAttachments();
    }
  }

  function renderAttachments() {
    const box = $('#attachments');
    box.innerHTML = '';
    for (const f of state.pending) {
      const cls =
        f.state === 'done' ? 'att done' : f.state === 'failed' ? 'att failed' : 'att uploading';
      const node = el('div', cls);
      const stateTxt =
        f.state === 'done' ? '已解析' : f.state === 'failed' ? '失败' : '解析中…';
      node.innerHTML =
        `<span class="a-ico">${fileIcon(f.name)}</span>` +
        `<span class="a-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>` +
        `<span class="a-state">${stateTxt}</span>` +
        `<button class="a-drop" title="移除">${ICON.close}</button>`;
      node.querySelector('.a-drop').onclick = () => {
        state.pending = state.pending.filter((x) => x.id !== f.id);
        renderAttachments();
      };
      box.appendChild(node);
    }
  }

  /* ══════════════════════ 语音 ══════════════════════ */

  function encodeWav(float32, sampleRate) {
    const len = float32.length;
    const buf = new ArrayBuffer(44 + len * 2);
    const view = new DataView(buf);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + len * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, len * 2, true);
    let off = 44;
    for (let i = 0; i < len; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function blobToWav(blob, targetRate = 16000) {
    const arr = await blob.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(arr.slice(0));
    await ctx.close();

    const ch = decoded.numberOfChannels;
    const len = decoded.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const d = decoded.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
    }

    const ratio = decoded.sampleRate / targetRate;
    const outLen = Math.floor(len / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const t = i * ratio;
      const i0 = Math.floor(t);
      const i1 = Math.min(i0 + 1, len - 1);
      const f = t - i0;
      out[i] = mono[i0] * (1 - f) + mono[i1] * f;
    }
    return encodeWav(out, targetRate);
  }

  let recorder = null;
  let recChunks = [];
  let recTimer = null;

  async function toggleRecord() {
    const btn = $('#micBtn');
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('当前浏览器不支持录音');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].find(
        (m) => window.MediaRecorder?.isTypeSupported?.(m),
      );
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recChunks = [];
      recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
      recorder.onstop = async () => {
        clearTimeout(recTimer);
        btn.classList.remove('recording');
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recChunks, { type: recorder.mimeType });
        if (blob.size < 1200) return;
        toast('识别中…', 6000);
        try {
          const wav = await blobToWav(blob);
          const fd = new FormData();
          fd.append('file', wav, 'speech.wav');
          const res = await fetch(apiUrl('v1/tools/asr'), {
            method: 'POST',
            headers: authHeaders(),
            body: fd,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
          const text = data.text || '';
          if (text) insertAtCursor(text);
          else toast('没有识别到内容');
        } catch (err) {
          toast(`识别失败：${err.message}`, 4000);
        }
      };
      recorder.start();
      btn.classList.add('recording');
      toast('录音中，再点一次结束（最长 120 秒）', 3000);
      // ASR 单次上限 120 秒
      recTimer = setTimeout(() => recorder?.state === 'recording' && recorder.stop(), 115000);
    } catch (err) {
      toast('无法访问麦克风：' + err.message, 4000);
    }
  }

  function insertAtCursor(text) {
    const ta = $('#input');
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
    ta.focus();
    autoGrow();
  }

  let currentAudio = null;
  let speakBtn = null;

  async function speakText(text, btn) {
    if (!text) return;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
      speakBtn?.classList.remove('playing');
      if (speakBtn === btn) return; // 同一个按钮 = 停止
    }
    // TTS 上限 10,000 计费字符（汉字按 2 计）
    const trimmed = text.slice(0, 4000);
    speakBtn = btn;
    try {
      toast('合成语音中…', 5000);
      const res = await fetch(apiUrl('v1/tools/tts'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          text: trimmed,
          voice_id: state.settings.voice || 'stella',
          format: 'wav',
          filter_markdown: true,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error?.message || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      currentAudio = new Audio(url);
      currentAudio.onended = () => {
        URL.revokeObjectURL(url);
        currentAudio = null;
        btn.classList.remove('playing');
      };
      await currentAudio.play();
      btn.classList.add('playing');
    } catch (err) {
      toast(`朗读失败：${err.message}`, 4000);
    }
  }

  /* ══════════════════════ 导出 / 导入 ══════════════════════ */

  function conversationToMarkdown(conv) {
    const lines = [`# ${conv.title || '对话'}`, '', `> 导出时间：${new Date().toLocaleString('zh-CN')}`, ''];
    const reg = buildRegistry(conv);
    for (const m of conv.messages) {
      if (m.role === 'user') {
        lines.push('## 🧑 我', '');
        for (const f of m._ui?.files || []) lines.push(`> 📎 附件：${f.name}`, '');
        if (m.text) lines.push(m.text, '');
      } else if (m.role === 'assistant') {
        lines.push('## ✦ DeepSeek', '');
        for (const b of m.content || []) {
          if (b.type === 'thinking' && b.thinking?.trim()) {
            lines.push('<details><summary>思考过程</summary>', '', b.thinking.trim(), '', '</details>', '');
          } else if (b.type === 'text' && b.text?.trim()) {
            let t = b.text;
            const cites = b.citations || [];
            if (cites.length) {
              const marks = [];
              for (const c of cites) {
                const n = reg.index.get(c.url);
                if (n) marks.push(`[${n}]`);
              }
              if (marks.length) t += ` ${[...new Set(marks)].join('')}`;
            }
            lines.push(t.trim(), '');
          }
        }
      }
    }
    if (reg.list.length) {
      lines.push('## 参考来源', '');
      for (const s of reg.list) lines.push(`${s.n}. [${s.title || s.url}](${s.url})`);
      lines.push('');
    }
    return lines.join('\n');
  }

  function download(name, text, mime = 'text/markdown') {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function exportCurrent() {
    const conv = activeConv();
    if (!conv?.messages.length) return toast('当前对话为空');
    download(`${(conv.title || 'conversation').replace(/[/\\?%*:|"<>]/g, '-')}.md`, conversationToMarkdown(conv));
    toast('已导出 Markdown');
  }

  function exportAll() {
    download(
      `deepseek-studio-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify({ version: 1, conversations: state.conversations }, null, 2),
      'application/json',
    );
    toast('已导出全部对话');
  }

  function importAll(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const arr = Array.isArray(data) ? data : data.conversations;
        if (!Array.isArray(arr)) throw new Error('格式不正确');
        if (state.conversations.length && !confirm('导入会覆盖当前所有对话，继续？')) return;
        state.conversations = arr;
        state.activeId = arr[0]?.id || null;
        save();
        renderConvList();
        renderChat();
        toast(`已导入 ${arr.length} 个对话`);
      } catch (err) {
        toast('导入失败：' + err.message, 4000);
      }
    };
    reader.readAsText(file);
  }

  /* ══════════════════════ UI 绑定 ══════════════════════ */

  function autoGrow() {
    const ta = $('#input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 190) + 'px';
    $('#sendBtn').disabled = !ta.value.trim() && !state.pending.some((f) => f.fileId);
  }

  function updateSendBtn() {
    const btn = $('#sendBtn');
    if (state.streaming) {
      btn.classList.add('stop');
      btn.innerHTML = ICON.stop;
      btn.disabled = false;
      btn.title = '停止生成';
    } else {
      btn.classList.remove('stop');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-3.5-6.5z"/></svg>';
      btn.title = '发送';
      autoGrow();
    }
  }

  function toggleClass(btn, on) {
    btn.classList.toggle('on', on);
  }

  function syncToggles() {
    toggleClass($('#tgThink'), state.settings.thinking);
    toggleClass($('#tgSearch'), state.settings.webSearch);
    toggleClass($('#tgReadUrl'), state.settings.readUrl);
    toggleClass($('#tgSafety'), state.settings.safety === 'high');
    $('#tgSafety').title =
      state.settings.safety === 'high'
        ? '内容安全：high（对外服务必须开启）'
        : '内容安全：low（等同默认检查）';
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.settings.theme;
  }

  function closeMobileSidebar() {
    $('#app').classList.remove('sidebar-open');
  }

  function openSettings() {
    $('#setKey').value = state.settings.apiKey || '';
    $('#setModel').value = state.settings.model || MODEL;
    $('#setSafety').value = state.settings.safety;
    $('#setParsing').value = state.settings.parsing;
    $('#setVoice').value = state.settings.voice;
    $('#setTitle').value = state.settings.title;
    $('#setLocale').value = `${state.settings.location || ''}`;
    const keyHint = $('#keyHint');
    if (isDirect()) {
      keyHint.textContent = '纯静态部署下没有服务端，必须填写；Key 只存在本机 localStorage，不会上传。';
      $('#healthHint').textContent = '直连模式';
    } else {
      keyHint.textContent = '留空则使用服务端环境变量 DEEPSEEK_API_KEY。';
      $('#healthHint').textContent = state.serverKey ? '服务端已配置 API Key，可留空' : '未检测到服务端 Key，请填写';
    }
    $('#settingsModal').hidden = false;
  }

  function bindEvents() {
    /* 侧栏 */
    $('#newChat').onclick = () => {
      newConversation();
      closeMobileSidebar();
    };
    $('#collapseSidebar').onclick = () => {
      state.settings.sidebarCollapsed = true;
      $('#app').classList.add('sidebar-collapsed');
      save();
    };
    $('#openSidebar').onclick = () => $('#app').classList.add('sidebar-open');
    $('#toggleTheme').onclick = () => {
      state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      save();
    };

    /* 溯源 */
    $('#toggleSources').onclick = () => {
      state.settings.sourcesOpen = !state.settings.sourcesOpen;
      $('#app').classList.toggle('sources-open', state.settings.sourcesOpen);
      save();
      if (state.settings.sourcesOpen) renderSources();
    };
    $('#closeSources').onclick = () => {
      state.settings.sourcesOpen = false;
      $('#app').classList.remove('sources-open');
      save();
    };
    $$('.stab').forEach((tab) => {
      tab.onclick = () => {
        $$('.stab').forEach((t) => t.classList.toggle('active', t === tab));
        sourceTab = tab.dataset.tab;
        renderSources();
      };
    });
    $('#exportBtn').onclick = exportCurrent;

    /* 输入 */
    const ta = $('#input');
    ta.addEventListener('input', autoGrow);

    // 用户滚回底部就重新锚定，向上翻动则停止跟随
    const scroller = $('#chatScroll');
    scroller.addEventListener(
      'scroll',
      () => {
        // 位置与上次自动滚动一致 = 程序化滚动，忽略
        if (Math.abs(scroller.scrollTop - lastAutoScroll) < 2) return;
        state.pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
      },
      { passive: true },
    );
    scroller.addEventListener(
      'wheel',
      (e) => {
        if (e.deltaY < 0) state.pinned = false;
      },
      { passive: true },
    );
    scroller.addEventListener('touchmove', () => (state.pinned = false), { passive: true });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!state.streaming) send();
      }
    });

    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      if (state.streaming) {
        state.abort?.abort();
        return;
      }
      send();
    });

    /* 能力开关 */
    const toggles = {
      tgThink: 'thinking',
      tgSearch: 'webSearch',
      tgReadUrl: 'readUrl',
    };
    for (const [id, key] of Object.entries(toggles)) {
      $('#' + id).onclick = () => {
        state.settings[key] = !state.settings[key];
        syncToggles();
        save();
        if (key === 'webSearch' && !state.settings.webSearch && state.settings.thinking) {
          // 思考模式下没有联网工具就是纯思考，符合预期，不提示
        }
        if (key === 'thinking' && state.settings.thinking && state.settings.webSearch) {
          toast('思考模式已开：联网将变为「深度思考搜索」');
        }
      };
    }
    $('#tgSafety').onclick = () => {
      state.settings.safety = state.settings.safety === 'high' ? 'low' : 'high';
      syncToggles();
      save();
      toast(state.settings.safety === 'high' ? '内容安全已开启（high）' : '内容安全已关闭（low）');
    };

    /* 附件 */
    $('#attachBtn').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = (e) => {
      if (e.target.files?.length) uploadFiles(Array.from(e.target.files));
      e.target.value = '';
    };

    const composer = $('#composer');
    const hint = $('#dropHint');
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      dragDepth++;
      hint.classList.add('show');
      composer.classList.add('drag-over');
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) {
        hint.classList.remove('show');
        composer.classList.remove('drag-over');
      }
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      hint.classList.remove('show');
      composer.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) uploadFiles(files);
    });

    /* 语音 */
    $('#micBtn').onclick = toggleRecord;

    /* 空态建议 */
    $$('.ecard').forEach((card) => {
      card.onclick = () => {
        ta.value = card.dataset.prompt;
        autoGrow();
        ta.focus();
      };
    });

    /* 代码复制 & 引用点击 */
    document.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        const code = copyBtn.closest('.code-block')?.querySelector('code')?.textContent || '';
        navigator.clipboard.writeText(code).then(() => {
          copyBtn.textContent = '已复制';
          setTimeout(() => (copyBtn.textContent = '复制'), 1500);
        });
        return;
      }
      const cite = e.target.closest('sup.cite');
      if (cite) {
        const n = Number(cite.dataset.src);
        if (!state.settings.sourcesOpen) {
          state.settings.sourcesOpen = true;
          $('#app').classList.add('sources-open');
          save();
        }
        renderSources();
        const item = $(`.src-item[href]`);
        $$('.src-item').forEach((si) => (si.style.background = ''));
        const target = $$('.src-item')[n - 1];
        if (target) {
          target.style.background = 'var(--surface-hover)';
          target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        void item;
      }
    });

    /* 设置 */
    $('#openSettings').onclick = openSettings;
    $('#closeSettings').onclick = () => ($('#settingsModal').hidden = true);
    $('#settingsModal').addEventListener('click', (e) => {
      if (e.target.id === 'settingsModal') $('#settingsModal').hidden = true;
    });
    $('#saveSettings').onclick = () => {
      state.settings.apiKey = $('#setKey').value.trim();
      state.settings.model = $('#setModel').value.trim() || MODEL;
      state.settings.safety = $('#setSafety').value;
      state.settings.parsing = $('#setParsing').value;
      state.settings.voice = $('#setVoice').value;
      state.settings.title = $('#setTitle').value;
      state.settings.location = $('#setLocale').value.trim();
      save();
      syncToggles();
      $('#modelChip').textContent = state.settings.model;
      $('#settingsModal').hidden = true;
      toast('设置已保存');
    };
    $('#exportAll').onclick = exportAll;
    $('#importAll').onclick = () => {
      const input = el('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = () => input.files?.[0] && importAll(input.files[0]);
      input.click();
    };
    $('#clearAll').onclick = () => {
      if (!confirm('确定清空全部对话？此操作不可恢复。')) return;
      state.conversations = [];
      state.activeId = null;
      save();
      renderConvList();
      renderChat();
      toast('已清空');
    };

    /* 快捷键 */
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        newConversation();
      }
      if (e.key === 'Escape') {
        $('#settingsModal').hidden = true;
        closeMobileSidebar();
      }
      const tag = document.activeElement?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        $('#input').focus();
      }
    });
  }

  /* ══════════════════════ 启动 ══════════════════════ */

  /** 把当前是「本地代理」还是「直连」告诉用户，避免静态部署时误以为代理挂了 */
  function updateModeUi() {
    const direct = isDirect();
    const meter = $('#usageMeter');
    if (meter) {
      meter.textContent = direct ? '直连 api.deepseek.com' : '本地代理 · 已连接';
      meter.title = direct
        ? '纯静态部署：浏览器直接请求 DeepSeek API（CORS 已放行），Key 只保存在本机'
        : '请求经 server.mjs 转发，Key 可由服务端环境变量注入';
    }
  }

  async function init() {
    load();
    applyTheme();
    bindEvents();
    syncToggles();
    $('#modelChip').textContent = state.settings.model || MODEL;
    if (state.settings.sourcesOpen) $('#app').classList.add('sources-open');
    if (state.settings.sidebarCollapsed) $('#app').classList.add('sidebar-collapsed');

    if (!state.conversations.length) {
      state.conversations = [];
      state.activeId = null;
    }
    if (!state.activeId && state.conversations.length) state.activeId = state.conversations[0].id;

    renderConvList();
    renderChat();
    autoGrow();

    const mode = await detectMode();
    state.mode = mode;
    updateModeUi();

    if (!state.serverKey && !state.settings.apiKey) {
      setTimeout(() => toast('请先在「设置」中填入 DeepSeek API Key', 5000), 800);
    }

    $('#input').focus();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
