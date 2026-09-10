#!/usr/bin/env node
/**
 * 后端进程管理 CLI（纯 Node.js，无依赖）
 * 用法：
 *   node scripts/manage.mjs start     提示用法（实际启动请用 npm run dev）
 *   node scripts/manage.mjs stop      通过 PID 文件发送 SIGTERM，等进程退出
 *   node scripts/manage.mjs status    显示当前 PID 文件状态
 *   node scripts/manage.mjs kill      强杀（兜底）
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '..');
const PID_FILE = path.join(backendRoot, 'data', 'backend.pid');
const PORT_FILE = path.join(backendRoot, 'data', 'backend.port');

/** 端口优先级：PORT 环境变量 > 端口文件 > 9200（与 backend/index.ts 一致） */
function readPort() {
  const envPort = Number(process.env.PORT || 0);
  if (Number.isInteger(envPort) && envPort > 0) return envPort;
  try {
    const p = Number(readFileSync(PORT_FILE, 'utf-8').trim());
    if (Number.isInteger(p) && p > 0) return p;
  } catch { /* 文件不存在 → 默认 */ }
  return 9200;
}
const PORT = readPort();

const cmd = process.argv[2];

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isWindows() {
  return process.platform === 'win32';
}

/** 检查 PID 是否还活着 */
function isAlive(pid) {
  try {
    if (isWindows()) {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8' });
      return out.includes(String(pid));
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

function sendSigterm(pid) {
  try {
    if (isWindows()) {
      // taskkill /PID 在 Windows 上常因"只能强行终止"被拒（受 process group 限制）。
      // 此处先尝试 soft terminate：成功就等 graceful handler 跑；超时再 fallback。
      execSync(`taskkill /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

function sendForceTerminate(pid) {
  try {
    if (isWindows()) execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function clearPidFile() {
  if (existsSync(PID_FILE)) {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
}

async function waitDead(pid, timeoutMs = 6000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return !isAlive(pid);
}

function cmdStatus() {
  const pid = readPid();
  if (!pid) {
    console.log(`[status] no PID file (${PID_FILE}). Backend not running (or was force-killed).`);
    return;
  }
  if (isAlive(pid)) {
    console.log(`[status] backend RUNNING, pid=${pid}, port=${PORT}`);
    console.log(`         PID file: ${PID_FILE}`);
    console.log(`         Stop with: npm run backend:stop`);
  } else {
    console.log(`[status] stale PID file (pid=${pid} not alive). Cleaning.`);
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
}

async function cmdStop() {
  const pid = readPid();
  if (!pid) {
    console.log('[stop] no PID file. Backend not running.');
    return;
  }
  if (!isAlive(pid)) {
    console.log(`[stop] pid=${pid} not alive. Removing stale PID file.`);
    clearPidFile();
    return;
  }
  console.log(`[stop] requesting graceful shutdown for pid=${pid}…`);
  // 1) 尝试软终止（Unix SIGTERM；Windows taskkill /PID，跨 session 可能被拒）
  const softOk = sendSigterm(pid);
  if (!softOk) {
    if (isWindows()) {
      console.warn('[stop] soft terminate denied by OS (跨 session/Permissions). Falling back to /F.');
    } else {
      console.error('[stop] failed to send SIGTERM.');
      process.exit(1);
    }
  }
  // 2) 等 6s 让 graceful handler 跑完
  let died = await waitDead(pid, 6000);
  // 3) Windows 软终止被拒 → 直接 /F；或 6s 仍未死 → /F 兜底
  if (!died) {
    if (!softOk || isWindows()) {
      console.warn('[stop] forcing terminate…');
      if (!sendForceTerminate(pid)) {
        console.error('[stop] force terminate failed.');
        process.exit(1);
      }
      died = await waitDead(pid, 4000);
    }
  }
  // 4) 最终无论生死都清 PID 文件（后端正常退出也会自己清，这里是兜底）
  clearPidFile();
  if (died) {
    console.log('[stop] backend stopped.');
  } else {
    console.error('[stop] backend still alive after force terminate. Manual intervention needed.');
    process.exit(2);
  }
}

function cmdKill() {
  const pid = readPid();
  if (!pid) {
    console.log('[kill] no PID file.');
    return;
  }
  if (sendForceTerminate(pid)) {
    console.log(`[kill] pid=${pid} force-killed.`);
  } else {
    console.error(`[kill] failed to force-kill pid=${pid}.`);
    process.exit(1);
  }
  clearPidFile();
}

function cmdStart() {
  console.log('[start] this CLI does not fork. Run `npm run dev -w packages/backend`');
  console.log('        Then `npm run backend:stop` to gracefully shutdown.');
}

switch (cmd) {
  case 'start':  cmdStart(); break;
  case 'stop':   await cmdStop(); break;
  case 'status': cmdStatus(); break;
  case 'kill':   cmdKill(); break;
  default:
    console.log('Usage: node scripts/manage.mjs <start|stop|status|kill>');
    process.exit(1);
}
