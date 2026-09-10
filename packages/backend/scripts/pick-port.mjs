#!/usr/bin/env node
/**
 * 端口预检脚本：为后端选一个可绑定的端口，写入 data/backend.port。
 *
 * 为什么需要它：
 *   Windows 上 Hyper-V / WSL / winnat 会动态保留端口区间（netsh 的 excludedportrange），
 *   且每次重启可能变化。硬编码端口（8787 → 9200 都踩过）迟早再次落进保留区间，
 *   后端 listen 直接 EACCES 起不来，前端代理全部 ECONNREFUSED。
 *
 * 用法（npm 自动调用，也可手动）：
 *   node scripts/pick-port.mjs
 *
 * 规则：
 *   1. 显式 PORT 环境变量 → 只验证该端口（绑定失败则报错退出，不漂移）
 *   2. 否则从 9200 起向上探测最多 16 个端口，取第一个可绑定的
 *   3. 结果写入 data/backend.port，backend 与 vite 均读该文件对齐
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', 'data');
const portFile = path.join(dataDir, 'backend.port');

const DEFAULT_PORT = 9200;
const TRY_COUNT = 16;

/** 端口是否可以绑定（bind 后立即释放） */
function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

const envPort = Number(process.env.PORT || 0);
let port;

if (Number.isInteger(envPort) && envPort > 0) {
  // 用户显式指定：验证可用性，但无论结果都写入（让后端自己报出真实错误）
  port = envPort;
  if (!(await canBind(port))) {
    console.error(`[pick-port] 指定的 PORT=${port} 当前无法绑定（可能被占用或被系统保留）`);
    process.exit(1);
  }
} else {
  port = DEFAULT_PORT;
  let found = false;
  for (let i = 0; i < TRY_COUNT; i++) {
    if (await canBind(port)) { found = true; break; }
    port++;
  }
  if (!found) {
    console.error(`[pick-port] ${DEFAULT_PORT}..${DEFAULT_PORT + TRY_COUNT - 1} 全部无法绑定，请用 PORT 环境变量指定其他端口`);
    process.exit(1);
  }
}

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(portFile, String(port));
console.log(`[pick-port] backend port -> ${port} (${portFile})`);
