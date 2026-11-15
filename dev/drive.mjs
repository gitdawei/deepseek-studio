/**
 * 无头 Chrome 验证脚本（零依赖，走 CDP）
 *
 * 用法：
 *   node dev/drive.mjs <url> <out.png> [--send "消息"] [--wait 4000]
 *
 * 流程：启动 headless Chrome → 打开页面 → 可选地触发一次发送 → 截图。
 * 用于在没有真实 Key、或不想消耗 token 的情况下验证流式渲染。
 *
 * 注意：
 *   - Node 22 起才有全局 WebSocket，请勿用更低版本
 *   - macOS 上 headless Chrome 需要 --no-sandbox 与 --remote-allow-origins=*，
 *     否则 CDP 握手后渲染进程会直接崩溃（Inspector.targetCrashed）
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CDP_PORT || 9333);

const args = process.argv.slice(2);
const url = args[0] || 'http://127.0.0.1:8787';
const out = args[1] || 'shot.png';
const sendIdx = args.indexOf('--send');
const sendText = sendIdx >= 0 ? args[sendIdx + 1] : null;
const waitIdx = args.indexOf('--wait');
const waitMs = waitIdx >= 0 ? Number(args[waitIdx + 1]) : 5000;
const evalIdx = args.indexOf('--eval');
const evalJs = evalIdx >= 0 ? args[evalIdx + 1] : null;
const wIdx = args.indexOf('--width');
const hIdx = args.indexOf('--height');
const viewportW = wIdx >= 0 ? Number(args[wIdx + 1]) : 1440;
const viewportH = hIdx >= 0 ? Number(args[hIdx + 1]) : 900;
const mobile = args.includes('--mobile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 继续等 */
    }
    await sleep(150);
  }
  throw new Error('Chrome 调试端口未就绪');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });

    // 连接断开时让所有在途请求失败，避免静默挂死
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  send(method, params = {}, timeout = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  waitFor(method, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeout);
      this.on(method, (p) => {
        clearTimeout(t);
        resolve(p);
      });
    });
  }
}

async function main() {
  const profile = mkdtempSync(path.join(tmpdir(), 'dsstudio-'));

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--remote-allow-origins=*',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  chrome.on('error', (e) => console.error('  ! Chrome 启动失败：', e.message));

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  };

  try {
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);

    const target = await (
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, {
        method: 'PUT',
      })
    ).json();

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });

    const cdp = new CDP(ws);
    const problems = [];

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.exceptionThrown', (p) => {
      problems.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '异常');
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') problems.push(p.args?.map((a) => a.value ?? a.description).join(' '));
    });
    cdp.on('Inspector.targetCrashed', () => problems.push('渲染进程崩溃（targetCrashed）'));

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewportW,
      height: viewportH,
      deviceScaleFactor: 2,
      mobile,
    });

    const loaded = cdp.waitFor('Page.loadEventFired').catch(() => null);
    await cdp.send('Page.navigate', { url });
    await loaded;
    await sleep(800);

    if (sendText) {
      const script = `
        (() => {
          const ta = document.querySelector('#input');
          if (!ta) return 'no-input';
          ta.value = ${JSON.stringify(sendText)};
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          const form = document.querySelector('#composer');
          if (form.requestSubmit) form.requestSubmit();
          else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return 'sent';
        })()
      `;
      const r = await cdp.send('Runtime.evaluate', { expression: script, returnByValue: true });
      console.log('  → 发送:', r.result?.value);
    }

    await sleep(waitMs);

    if (evalJs) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: evalJs,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        console.log('  ! eval 异常:', r.exceptionDetails.text);
      } else {
        console.log('  → eval:', JSON.stringify(r.result?.value)?.slice(0, 1200));
      }
      await sleep(900);
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  → 截图已保存：${out}`);

    if (problems.length) {
      console.log('  → 页面问题：');
      for (const p of [...new Set(problems)]) console.log('     · ' + String(p).slice(0, 300));
    } else {
      console.log('  → 无 JS 异常');
    }

    ws.close();
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error('验证失败：', e.message);
  process.exit(1);
});
