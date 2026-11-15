/**
 * 极简 Markdown 渲染器（零依赖，离线可用）
 * 支持：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 代码块 / 链接 / 图片 /
 *      有序与无序列表（含嵌套、任务列表）/ 引用 / 分隔线 / 表格 / 段落
 *
 * 安全：先整体 HTML 转义，再解析 Markdown，因此不会引入未转义标签。
 * 扩展：{{CIT:n}} 占位符在渲染后会被替换为引用角标。
 */
(function () {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  function safeUrl(url) {
    const u = String(url || '').trim();
    if (/^(https?:|mailto:|tel:|#|\/)/i.test(u)) return u;
    return '#';
  }

  /* ---------------- 行内解析 ---------------- */

  function inline(raw) {
    const codes = [];
    // 0. 先整体转义：模型输出属于不可信内容，绝不能让原始标签进 DOM。
    //    转义不影响 ` * [ ] 等 Markdown 记号，后续解析照常。
    let s = escapeHtml(raw);

    // 1. 行内代码先摘出来，避免其中内容被当作 Markdown
    s = s.replace(/(`+)([\s\S]*?)\1/g, (_, _tick, code) => {
      const token = `\u0001${codes.length}\u0001`;
      codes.push(`<code>${code.trim()}</code>`);
      return token;
    });

    // 2. 图片 ![alt](src)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => {
      return `<img src="${safeUrl(src)}" alt="${alt}" loading="lazy">`;
    });

    // 3. 链接 [text](href)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
      const ext = /^https?:/i.test(href);
      return `<a href="${safeUrl(href)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
    });

    // 4. 裸链接
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => {
      return `${pre}<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

    // 5. 强调
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // 6. 还原行内代码
    s = s.replace(/\u0001(\d+)\u0001/g, (_, n) => codes[Number(n)] ?? '');

    return s;
  }

  /* ---------------- 块级解析 ---------------- */

  const RE_FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
  const RE_HEADING = /^(#{1,6})\s+(.*)$/;
  const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
  const RE_QUOTE = /^\s*>\s?/;
  const RE_UL = /^(\s*)([-*+])\s+(.*)$/;
  const RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
  const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  const isBlockStart = (line) =>
    RE_FENCE.test(line) ||
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_QUOTE.test(line) ||
    RE_UL.test(line) ||
    RE_OL.test(line);

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }

  function renderList(lines, start) {
    let i = start;
    const items = []; // {indent, ordered, content:[lines]}
    while (i < lines.length) {
      const line = lines[i];
      const ul = line.match(RE_UL);
      const ol = line.match(RE_OL);
      if (!ul && !ol) break;
      const m = ul || ol;
      items.push({ indent: m[1].length, ordered: Boolean(ol), text: m[3] });
      i++;
    }

    // 缩进栈构建嵌套
    function build(idx, indent) {
      const ordered = items[idx].ordered;
      let html = ordered ? '<ol>' : '<ul>';
      while (idx < items.length) {
        const it = items[idx];
        if (it.indent < indent) break;
        if (it.indent > indent) {
          const sub = build(idx, it.indent);
          html = html.replace(/<\/(ul|ol)>$/, '') + sub.html + `</${sub.ordered ? 'ol' : 'ul'}>`;
          idx = sub.idx;
          continue;
        }
        let cls = '';
        let content = it.text;
        const task = content.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          cls = ' class="task"';
          const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
          content = `<input type="checkbox" disabled${checked}> ${inline(task[2])}`;
        } else {
          content = inline(content);
        }
        html += `<li${cls}>${content}</li>`;
        idx++;
      }
      html += ordered ? '</ol>' : '</ul>';
      return { html, idx };
    }

    const res = build(0, items[0]?.indent ?? 0);
    return { html: res.html, next: i };
  }

  function render(md) {
    const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      // 代码块
      const fence = line.match(RE_FENCE);
      if (fence) {
        const marker = fence[1][0];
        const lang = fence[2] || '';
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // 跳过闭合
        out.push(
          `<div class="code-block"><div class="code-head"><span>${escapeHtml(lang || 'text')}</span>` +
          `<button class="code-copy" type="button" data-copy>复制</button></div>` +
          `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre></div>`,
        );
        continue;
      }

      // 标题
      const h = line.match(RE_HEADING);
      if (h) {
        const lv = h[1].length;
        out.push(`<h${lv}>${inline(h[2].trim())}</h${lv}>`);
        i++;
        continue;
      }

      // 分隔线
      if (RE_HR.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      // 引用（递归渲染内部）
      if (RE_QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && (RE_QUOTE.test(lines[i]) || (lines[i].trim() && buf.length))) {
          buf.push(lines[i].replace(RE_QUOTE, ''));
          i++;
        }
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }

      // 表格
      if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
        const tb = rows
          .map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`)
          .join('');
        out.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
        continue;
      }

      // 列表
      if (RE_UL.test(line) || RE_OL.test(line)) {
        const res = renderList(lines, i);
        out.push(res.html);
        i = res.next;
        continue;
      }

      // 段落：收集到空行或下一个块级元素
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        // 表格需要在段落中被识别
        if (lines[i].includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) break;
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }

    return out.join('\n');
  }

  window.DSMarkdown = { render, escapeHtml, inline };
})();
