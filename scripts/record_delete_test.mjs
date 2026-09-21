#!/usr/bin/env node
/**
 * DELETE /records/:id 的容错回归
 *
 * 运行：node scripts/record_delete_test.mjs（需后端在跑）
 *
 * 背景：原实现在删 DB 行之前直接 `unlinkSync(file)`，没有任何保护。
 * 一旦文件不可删（Windows 上被播放器/上传句柄占用，或路径落在一个目录上），
 * unlinkSync 抛错 → Fastify 兜成 500 → **记录本身也删不掉**，前端还会静默失败。
 *
 * 这里用一个真实可复现的触发方式：「让 file_path 指向一个目录」。
 * 目录无法被 unlinkSync 删除（EPERM/EISDIR），等价于文件被占用。
 * 测试会先验证这个前提成立，再断言接口仍返回 204 且记录被清掉。
 */
import { existsSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { apiBase, installAutoCleanup } from './lib-test-utils.mjs';

const BASE = apiBase();
// 本次新建的项目在结束时自动清掉（断言失败 / 崩溃同样会清）
const cleanup = await installAutoCleanup(BASE);
const STORAGE = path.resolve('packages/backend/storage');

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}
async function req(method, p, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, init);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

// ─── 前提验证：unlinkSync 作用在目录上确实会抛错 ───
const probeDir = path.join(STORAGE, '__probe_is_dir__');
mkdirSync(probeDir, { recursive: true });
let probeThrew = null;
try { unlinkSync(probeDir); } catch (e) { probeThrew = e.code ?? e.message; }
assert(probeThrew !== null,
  '前提：unlinkSync(目录) 会抛错（等价于文件被占用时的场景）',
  `未抛错（code=${probeThrew}）`);
try { rmdirSync(probeDir); } catch { /* ignore */ }

// ─── 构造一条 file_path 指向目录的记录 ───
const { body: pj } = await req('POST', '/projects', { title: '记录删除容错' });
const pid = pj.data.id;
const { body: rec } = await req('POST', '/records', {
  project_id: pid,
  config_snapshot: { width: 1280, height: 720, fps: 30 },
  duration_ms: 1000,
  size_bytes: 10,
});
const rid = rec.data.id;

// 上传一个真文件，拿到后端生成的 file_path
const fd = new FormData();
fd.append('file', new Blob([new Uint8Array(64)], { type: 'video/mp4' }), 'x.mp4');
const up = await fetch(`${BASE}/records/${rid}/file`, { method: 'POST', body: fd });
const upJson = await up.json().catch(() => ({}));
const rel = upJson.data?.file_path;
assert(up.status === 201 && !!rel, '上传成片文件成功', `status=${up.status} rel=${rel}`);

// 把文件换成同名目录 → 模拟"删不掉"
const full = path.join(STORAGE, rel);
if (existsSync(full)) unlinkSync(full);
mkdirSync(full, { recursive: true });

// ─── 关键断言：删除记录必须成功 ───
const del = await req('DELETE', `/records/${rid}`);
assert(del.status === 204,
  '文件不可删时 DELETE /records/:id 仍返回 204（不让整条记录删不掉、不冒 500）',
  `status=${del.status} body=${JSON.stringify(del.body)}`);

const list = await req('GET', `/records?projectId=${pid}`);
const stillThere = (list.body.data ?? []).some(r => r.id === rid);
assert(!stillThere, 'DB 记录已被清除（不再出现在列表里）', `stillThere=${stillThere}`);

// 目录残留不应阻塞（修复后磁盘上可能留孤儿目录，手工清）
try { if (existsSync(full)) rmdirSync(full); } catch { /* ignore */ }
await cleanup();

console.log(`\n记录删除容错：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
