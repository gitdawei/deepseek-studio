#!/usr/bin/env node
/**
 * 构建静态产物到 dist/ —— 供纯静态托管使用（Netlify / Vercel / Cloudflare Pages / GitHub Pages）。
 *
 * 纯静态模式下没有 server.mjs，前端会自动探测 /api/health 失败后回退成
 * 直连 https://api.deepseek.com（该域名的 CORS 已放行 authorization 与 x-api-key）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'public');
const OUT = path.join(__dirname, 'dist');

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(a, b);
    else await fs.copyFile(a, b);
  }
}

await rmrf(OUT);
await copyDir(SRC, OUT);

// 显式告诉前端「这里没有代理」，省掉一次 404 探测
await fs.writeFile(
  path.join(OUT, 'config.js'),
  '// 由 build.mjs 生成：静态托管没有 Node 代理，直接连官方 API\n' +
    "window.DS_CONFIG = { apiBase: 'https://api.deepseek.com' };\n",
);

// 把 config.js 插到 app.js 之前
const indexPath = path.join(OUT, 'index.html');
let html = await fs.readFile(indexPath, 'utf8');
// 用相对路径：GitHub Pages 项目站挂在 /<repo>/ 子路径下，绝对路径会 404
html = html.replace('<script src="app.js"></script>', '<script src="config.js"></script>\n<script src="app.js"></script>');
await fs.writeFile(indexPath, html);

const files = await fs.readdir(OUT);
console.log(`dist/ 构建完成：${files.join(', ')}`);
