/**
 * 后端进程管理脚本的回归测试。
 * 用 spawnSync 直接 spawn（不走 cmd.exe，避免 bash↔cmd 路径转义坑）。
 *
 * 前置：若想测「后端运行中」的 status 报告，请先启动：
 *   cd "S:/My event/projects/bar_video/packages/backend"
 *   "C:\Users\Mr.hancard\.workbuddy\binaries\node\versions\22.22.2-2\node.exe" --import tsx src/index.ts
 * 后置：测试会把后端 stop（如果原本在跑），并清理 stale PID 文件。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBackendPort } from './lib-port.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const backend = path.join(repoRoot, 'packages', 'backend');
const pidFile = path.join(backend, 'data', 'backend.pid');
// 用「运行测试的同一 node」拉起后端，避免硬编码另一版本 node 导致原生模块 ABI 不匹配
const nodeBin = process.execPath;
const manageScript = path.join(backend, 'scripts', 'manage.mjs');
const PORT = getBackendPort();

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;

function run(subCmd) {
  return spawnSync(nodeBin, [manageScript, subCmd], { encoding: 'utf-8' });
}

function ok(cond, msg, extra = '') {
  if (cond) { pass++; console.log(`${GRN}\u2713${RST} ${msg}`); }
  else { fail++; console.log(`${RED}\u2717${RST} ${msg}${extra ? ' \u2014 ' + extra : ''}`); }
}

function readPidFromFile() {
  if (!existsSync(pidFile)) return null;
  const p = Number(readFileSync(pidFile, 'utf-8').trim());
  return Number.isInteger(p) && p > 0 ? p : null;
}

function isAlive(pid) {
  try {
    const r = spawnSync('tasklist', [`/FI`, `PID eq ${pid}`, `/NH`], { encoding: 'utf-8' });
    return (r.stdout || '').includes(String(pid));
  } catch { return false; }
}

function portBusy(port) {
  // 只关心 LISTENING（TIME_WAIT/CLOSE_WAIT 等不算占据）
  try {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf-8' });
    const lines = (r.stdout || '').split(/\r?\n/);
    for (const line of lines) {
      if (!line.includes(':' + port + ' ')) continue;
      if (line.includes('LISTENING')) return true;
    }
    return false;
  } catch { return false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 用于"无后端时临时拉起一份测试用后端"
// spawn detached、stdio ignore，父进程退出后 Node 这边不会影响
import { spawn } from 'node:child_process';
function startBackendBackground() {
  const proc = spawn(nodeBin, ['--import', 'tsx', path.join(backend, 'src', 'index.ts')], {
    cwd: backend,
    detached: false,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  return proc;
}

function waitForHealth(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(async (resolve) => {
    while (Date.now() < deadline) {
      if (existsSync(pidFile)) {
        const p = readPidFromFile();
        if (p && isAlive(p)) {
          // 还要 health check 通过
          const r = spawnSync(nodeBin, ['-e', `fetch("http://127.0.0.1:${PORT}/api/v1/health").then(r=>r.text()).then(t=>process.exit(t.includes("ok")?0:1)).catch(e=>process.exit(2))`], { encoding: 'utf-8', timeout: 3000 });
          if (r.status === 0) return resolve(true);
        }
      }
      await sleep(400);
    }
    resolve(false);
  });
}

// 起始状态
const startState = {
  pidFileExists: existsSync(pidFile),
  pidInFile: readPidFromFile(),
  portBusy: portBusy(PORT),
};
console.log(`${YEL}[setup]${RST} 起始: pidFile=${startState.pidFileExists} pid=${startState.pidInFile} port=${PORT}:${startState.portBusy}`);

// --- 1. 无 PID 文件时 status/stop idempotent ---
// 只在没有 live 后端时才测，否则会把活的 PID 文件删掉
console.log('\n--- 1. 无 PID 文件状态 ---');
const initialPortBusy = portBusy(PORT);
if (initialPortBusy) {
  console.log(`${YEL}[skip]${RST} 当前已有后端在跑，保护 PID 文件不被测试破坏`);
} else {
  if (existsSync(pidFile)) unlinkSync(pidFile);
  {
    const r = run('status');
    ok(r.status === 0 && (r.stdout || '').includes('no PID file'),
      'status (无 PID 文件) exit=0 idempotent',
      `code=${r.status} out=${(r.stdout||'').slice(0,120)}`);
  }
  {
    const r = run('stop');
    ok(r.status === 0 && (r.stdout || '').includes('no PID file'),
      'stop (无 PID 文件) exit=0 idempotent',
      `code=${r.status} out=${(r.stdout||'').slice(0,120)}`);
  }
}

// --- 2. 后端在跑时 status 报告 pid+port ---
// 任何状态都能测：没有就拉起，有就保留跑后还
console.log('\n--- 2. 后端在跑时 status ---');

// 如果端口忙但 PID 文件不在（孤儿），根据 netstat 找到 pid 重写 PID 文件
if (!existsSync(pidFile) && portBusy(PORT)) {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf-8' });
  const lines = (r.stdout || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes(':9200') || !line.includes('LISTENING')) continue;
    // 格式：TCP <local> <remote> LISTENING <pid>（含 \r 结束符）
    const tokens = line.trim().split(/\s+/);
    // tokens 示例：['TCP', '127.0.0.1:9200', '0.0.0.0:0', 'LISTENING', '44396']
    const pid = Number(tokens[tokens.length - 1]);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      writeFileSync(pidFile, String(pid));
      console.log(`  [setup] 重建孤儿进程的 PID 文件: ${pid}`);
      break;
    }
  }
}

let wasStartedForTest = false;
let livePid = readPidFromFile();
if (!livePid || !isAlive(livePid)) {
  console.log('  [setup] 后端没在跑，临时拉起一份用于测试…');
  startBackendBackground();
  const ok = await waitForHealth();
  if (!ok) {
    console.log(`${RED}[abort]${RST} 临时后端没起来，跳过 case 2`);
  } else {
    wasStartedForTest = true; // 测试自己起的，测完会 stop
    livePid = readPidFromFile();
  }
}
if (livePid && isAlive(livePid)) {
  const r = run('status');
  const okOut = (r.stdout || '');
  ok(okOut.includes(`pid=${livePid}`) && okOut.includes(`port=${PORT}`),
    'status 报告真实 pid + port',
    `out=${okOut.slice(0, 200)}`);

  // 真 stop
  const r2 = run('stop');
  ok(r2.status === 0 && (r2.stdout || '').includes('backend stopped'),
    'stop 成功退出',
    `code=${r2.status} out=${(r2.stdout||'').slice(0,200)}`);
  ok(!existsSync(pidFile), 'PID 文件已清空');
  // 等端口进 TIME_WAIT 再彻底空：Windows TCP 释放需要数秒
  let portFreed = false;
  for (let i = 0; i < 30 && !portFreed; i++) {
    await sleep(300);
    if (!portBusy(PORT)) portFreed = true;
  }
  ok(portFreed, `${PORT} 端口已释放（最多等 9s）`);

  // 如果原本没在跑（拉起的就是为测试），测完就停了；不重启（避免干扰用户）
  if (!startState.portBusy) {
    console.log(`${YEL}[teardown]${RST} 测试用临时后端已停，与起始一致`);
  } else {
    // 起始就在跑，恢复
    console.log(`  [teardown] 起始 pid=${startState.pidInFile} 在跑但 PID 文件被销毁，现在端口已空，待用户重启`);
  }
}

// --- 3. stale PID 文件 → status 自动识别并清理 ---
console.log('\n--- 3. stale PID 文件清理 ---');
writeFileSync(pidFile, '99999999');
{
  const r = run('status');
  ok((r.stdout || '').includes('stale PID file'),
    'status 识别 stale PID 文件',
    `out=${(r.stdout||'').slice(0,200)}`);
  ok(!existsSync(pidFile), 'stale PID 文件被自动清理');
}

// --- 4. 假如测试前就在跑 —— 恢复 ---
if (startState.portBusy && startState.pidInFile && isAlive(startState.pidInFile)) {
  console.log(`${YEL}[teardown]${RST} 测试前 pid=${startState.pidInFile} 在跑，本测试未中途 stop，先恢复`);
}

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
