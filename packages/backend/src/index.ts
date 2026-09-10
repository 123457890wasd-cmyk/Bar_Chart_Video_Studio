/**
 * 后端入口：Fastify + SQLite(单机单用户)
 * 职责克制（方案 §4.1）：只做 CRUD / 导入 / 存档，渲染与转码全在浏览器。
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { healthRoutes } from './routes/health';
import { projectRoutes } from './routes/projects';
import { datasetRoutes } from './routes/datasets';
import { recordRoutes } from './routes/records';
import { datasourceRoutes } from './routes/datasources';
import db, { DATA_DIR } from './db';

const PORT_FILE = process.env.PORT_FILE ?? path.join(DATA_DIR, 'backend.port');
const DEFAULT_PORT = 9200;
const PORT_SEARCH_LIMIT = DEFAULT_PORT + 16;

/** 读 pick-port.mjs 预选的端口（不存在则 null） */
function readPortFromFile(): number | null {
  try {
    const p = Number(readFileSync(PORT_FILE, 'utf-8').trim());
    return Number.isInteger(p) && p > 0 ? p : null;
  } catch { return null; }
}

/** 端口优先级：PORT 环境变量 > 端口文件 > 9200 */
const PREFERRED_PORT = Number(process.env.PORT ?? 0) || readPortFromFile() || DEFAULT_PORT;
const HOST = process.env.HOST ?? '127.0.0.1';
const PID_FILE = process.env.PID_FILE ?? path.join(DATA_DIR, 'backend.pid');

const app = Fastify({
  logger: { level: 'warn' },
  bodyLimit: 64 * 1024 * 1024, // 大表导入
});

await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: 512 * 1024 * 1024 }, // 产物视频存档上传
});

await app.register(async (v1) => {
  v1.addHook('onRoute', (route) => { route.url = `/api/v1${route.url}`; });
  await healthRoutes(v1);
  await projectRoutes(v1);
  await datasetRoutes(v1);
  await recordRoutes(v1);
  await datasourceRoutes(v1);
});

app.setErrorHandler((err, _req, reply) => {
  const e = err as any;
  const code = e.code ?? 'E_INTERNAL';
  const status = e.statusCode ?? 500;
  app.log.warn(`${status} ${code}: ${e.message}`);
  reply.status(status).send({ error: { code: status === 500 ? 'E_INTERNAL' : code, message: e.message } });
});

// ---- 启动 ----
// Windows 上端口可能落进动态排除区间（EACCES）或被占用（EADDRINUSE）。
// 显式指定 PORT 时不漂移；否则从 PREFERRED_PORT 向上试探（最多到 9216）。
const envPortExplicit = Number(process.env.PORT ?? 0) > 0;
let actualPort = PREFERRED_PORT;
let listenErr: Error | null = null;

for (let p = PREFERRED_PORT; ; p++) {
  try {
    await app.listen({ port: p, host: HOST });
    actualPort = p;
    listenErr = null;
    break;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    listenErr = e as Error;
    if (envPortExplicit || p >= PORT_SEARCH_LIMIT) break;
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') continue; // 换下一个端口重试
    break; // 其他错误（配置类）不重试
  }
}

if (listenErr) {
  console.error(`[backend] startup failed on port ${actualPort}:`, listenErr.message);
  if (!envPortExplicit && actualPort === PREFERRED_PORT) {
    console.error(`[backend] 提示：${DEFAULT_PORT}..${PORT_SEARCH_LIMIT} 区间被系统保留/占用时，可用 PORT 环境变量指定其他端口`);
  }
  process.exit(1);
}

const PORT = actualPort;
// 把实际端口写回端口文件：vite 代理 / e2e 测试脚本都会读它对齐
writeFileSync(PORT_FILE, String(PORT));
console.log(`[backend] listening on http://${HOST}:${PORT} (API: /api/v1)`);
writeFileSync(PID_FILE, String(process.pid));
console.log(`[backend] PID ${process.pid} written to ${PID_FILE}`);

// ---- 优雅关闭 ----
// 设计要点：
// 1) 信号只处理一次（避免重复触发）
// 2) 关闭顺序：Fastify 先 close（拒绝新连接 + drain 在飞请求），再关 SQLite（flush WAL）
// 3) 5 秒强制 timeout 兜底，避免关闭过程卡死永远不退出
// 4) 任何路径都尝试清 PID 文件
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[backend] received ${signal}, shutting down gracefully…`);

  const forceKill = setTimeout(() => {
    console.error('[backend] shutdown timed out, forcing exit');
    process.exit(1);
  }, 5000);
  forceKill.unref();

  try {
    // 1. 先关 Fastify：拒绝新连接、等待在飞请求完成
    await app.close();
    console.log('[backend] fastify closed');
    // 2. 再关 SQLite：flush WAL、释放文件锁（避免下次启动 lock busy）
    db.close();
    console.log('[backend] sqlite closed');
    // 3. 清 PID 文件
    if (existsSync(PID_FILE)) {
      try { unlinkSync(PID_FILE); } catch { /* 别人删了也不要紧 */ }
      console.log(`[backend] removed ${PID_FILE}`);
    }
    clearTimeout(forceKill);
    console.log('[backend] shutdown complete');
    process.exit(0);
  } catch (e) {
    console.error('[backend] shutdown error:', (e as Error).message);
    process.exit(1);
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => void gracefulShutdown(sig));
}

// 兜底：进程退出前最后一次清 PID 文件（防止被 SIGKILL 杀死后残留）
process.on('exit', () => {
  if (existsSync(PID_FILE)) {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
});
