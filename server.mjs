#!/usr/bin/env node
/**
 * DeepSeek Studio — 零依赖本地服务
 *
 * 职责：
 *   1. 托管 public/ 下的静态前端
 *   2. 把 /api/* 反向代理到 https://api.deepseek.com/*
 *      - 解决浏览器直连的 CORS 问题
 *      - 全链路流式透传（SSE 不缓冲），支持超长请求
 *      - 支持 multipart 大文件上传（100MiB 的 /files 解析）
 *      - 若前端未提供密钥，则注入服务端环境变量 DEEPSEEK_API_KEY
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx node server.mjs
 *   PORT=8787 node server.mjs
 */

import http from 'node:http';
import https from 'node:https';
import { createReadStream, promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const UPSTREAM = new URL(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com');
const ENV_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/* 原样转发给上游的请求头（小写） */
const FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'anthropic-version',
  'anthropic-beta',
  'x-api-key',
  'authorization',
  'openai-beta',
];

/* 原样回传给浏览器的响应头 */
const RESPONSE_HEADERS = [
  'content-type',
  'content-encoding',
  'cache-control',
  'x-request-id',
  'request-id',
  'retry-after',
];

// 解析与推理都可能很久，禁用 Node 默认超时
const server = http.createServer((req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') return handleHealth(res);
  if (url.pathname.startsWith('/api/')) return proxy(req, res, url);
  return serveStatic(req, res, url);
});

function handleHealth(res) {
  sendJSON(res, 200, {
    ok: true,
    upstream: UPSTREAM.origin,
    serverKey: Boolean(ENV_KEY), // 只暴露是否存在，绝不暴露内容
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function proxy(req, res, url) {
  const targetPath = url.pathname.replace(/^\/api/, '') + url.search;
  const target = new URL(targetPath, UPSTREAM);

  const headers = {};
  for (const name of FORWARD_HEADERS) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  headers.host = target.host;

  // 前端没带密钥时，回落到服务端环境变量
  const clientKey = req.headers['x-api-key'] || req.headers['authorization'];
  if (!clientKey && ENV_KEY) {
    headers.authorization = `Bearer ${ENV_KEY}`;
    headers['x-api-key'] = ENV_KEY;
  }
  if (!headers['accept-encoding']) headers['accept-encoding'] = 'identity';

  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;

  const upstreamReq = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const outHeaders = {};
      for (const name of RESPONSE_HEADERS) {
        if (upstreamRes.headers[name]) outHeaders[name] = upstreamRes.headers[name];
      }
      // SSE 必须逐块下发，不被任何中间层聚合
      outHeaders['cache-control'] = outHeaders['cache-control'] || 'no-store';
      outHeaders['x-accel-buffering'] = 'no';
      outHeaders.connection = 'keep-alive';

      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      upstreamRes.on('data', (chunk) => {
        const ok = res.write(chunk);
        if (!ok) {
          upstreamRes.pause();
          res.once('drain', () => upstreamRes.resume());
        }
      });
      upstreamRes.on('end', () => res.end());
      upstreamRes.on('error', () => {
        try { res.end(); } catch { /* 连接已断开 */ }
      });
    },
  );

  upstreamReq.on('error', (err) => {
    if (res.headersSent) {
      try { res.end(); } catch { /* 忽略 */ }
      return;
    }
    sendJSON(res, 502, {
      error: { type: 'proxy_error', message: `无法连接 DeepSeek API：${err.message}` },
    });
  });

  // 客户端提前断开时一并取消上游请求
  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });

  req.pipe(upstreamReq);
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJSON(res, 405, { error: { message: 'Method Not Allowed' } });
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.join(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendJSON(res, 403, { error: { message: 'Forbidden' } });
  }

  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) throw new Error('is directory');

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(filePath).pipe(res);
  } catch {
    // SPA 回退
    try {
      const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(html);
    } catch {
      sendJSON(res, 404, { error: { message: 'Not Found' } });
    }
  }
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  \x1b[36m✦ DeepSeek Studio\x1b[0m 已启动');
  console.log(`  → http://${HOST}:${PORT}`);
  console.log(`  → 上游：${UPSTREAM.origin}`);
  console.log(
    ENV_KEY
      ? '  → 服务端密钥：已配置（浏览器可留空）'
      : '  → 服务端密钥：未配置（请在页面设置里填入 API Key，或设置 DEEPSEEK_API_KEY 后重启）',
  );
  console.log('');
});
