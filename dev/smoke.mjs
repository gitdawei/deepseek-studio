/**
 * 真机冒烟：用真实 DeepSeek API 打一次「联网搜索 + 安全校验 + 会话标题」请求。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxxx node dev/smoke.mjs
 *   DEEPSEEK_API_KEY=sk-xxxx node dev/smoke.mjs --thinking   # 换成深度思考搜索
 *
 * 会逐条打印事件与内容块，并校验关键字段，失败时退出码非 0。
 */

const KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const thinking = process.argv.includes('--thinking');

if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY 环境变量');
  process.exit(2);
}

const body = {
  model: 'deepseek-flash',
  max_tokens: 2048,
  stream: true,
  tools: [
    { type: 'deepseek_web_search', name: 'deepseek_web_search' },
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ],
  safety_check: { level: 'high' },
  title: { enabled: true },
  messages: [
    { role: 'latest_reminder', content: '2026-11-15,星期六,上海,Web,中文' },
    { role: 'user', content: 'DeepSeek 全家桶应用 API 是哪天发布的？只用一句话回答，并给出来源。' },
  ],
};
if (thinking) body.thinking = { type: 'enabled' };

const t0 = Date.now();

const res = await fetch(`${BASE}/anthropic/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': KEY },
  body: JSON.stringify(body),
});

console.log(`HTTP ${res.status}  ${res.headers.get('content-type')}`);

if (!res.ok) {
  console.error(await res.text());
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let saw = { thinking: 0, tool: 0, search: 0, fetch: 0, text: 0, citation: 0 };
let text = '';
let title = null;
let usage = null;
let stopReason = null;
let signalled = false;

outer: while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });

  let sep;
  while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
    const raw = buf.slice(0, sep);
    buf = buf.slice(sep + (buf[sep] === '\r' ? 4 : 2));
    const dataLine = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    let d;
    try {
      d = JSON.parse(dataLine.slice(5).trim());
    } catch {
      continue;
    }

    switch (d.type) {
      case 'content_block_start': {
        const b = d.content_block;
        if (b.type === 'thinking') saw.thinking++;
        if (b.type === 'server_tool_use') {
          saw.tool++;
          const act = b.input?.action;
          console.log(`  [工具] ${b.kind || ''} ${act} ${JSON.stringify(b.input).slice(0, 120)}`);
          if (act === 'search') signalled = true;
        }
        if (b.type === 'web_search_tool_result') {
          saw.search++;
          const n = Array.isArray(b.content) ? b.content.length : 0;
          console.log(`  [搜索结果] ${n} 条`);
          if (Array.isArray(b.content)) {
            for (const r of b.content.slice(0, 3)) console.log(`     · ${r.title || ''} — ${r.url || r.error_code}`);
          }
        }
        if (b.type === 'web_fetch_tool_result') {
          saw.fetch++;
          const c = b.content || {};
          console.log(`  [抓取] ${c.type} ${c.url || c.error_code || ''}`);
        }
        if (b.type === 'text') saw.text++;
        break;
      }
      case 'content_block_delta': {
        if (d.delta?.type === 'text_delta') text += d.delta.text;
        if (d.delta?.type === 'citations_delta') {
          saw.citation++;
          console.log(`  [引用] ${d.delta.citation?.title || ''} — ${d.delta.citation?.url || ''}`);
        }
        break;
      }
      case 'message_delta': {
        stopReason = d.delta?.stop_reason ?? stopReason;
        title = d.delta?.title ?? title;
        usage = d.usage ?? usage;
        break;
      }
      case 'error':
        console.error('  服务端 error 事件：', JSON.stringify(d.error));
        break outer;
      default:
        break;
    }
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log('\n──────── 结果 ────────');
console.log('标题     :', title || '（未返回）');
console.log('结束原因 :', stopReason);
console.log('内容块   :', JSON.stringify(saw));
console.log('正文     :', text.trim().slice(0, 300) || '（空）');
if (usage) {
  console.log('用量     :', `输入 ${usage.input_tokens} / 输出 ${usage.output_tokens}`,
    usage.server_tool_use ? `工具 ${JSON.stringify(usage.server_tool_use)}` : '');
}
console.log(`耗时     : ${secs}s`);

const problems = [];
if (!saw.text && stopReason !== 'refusal') problems.push('没有收到 text 块');
if (stopReason === 'refusal') problems.push('被内容审核拒答（safety_check 生效，属正常拦截）');
if (!title) problems.push('title 未返回（检查 title.enabled）');

if (problems.length) {
  console.log('\n提示：');
  for (const p of problems) console.log('  · ' + p);
}

console.log('\n冒烟完成。');
process.exit(stopReason === 'refusal' ? 0 : saw.text ? 0 : 1);
