#!/usr/bin/env node
/**
 * 编码解码回归：decodeBytes / decodeFile
 *
 * 运行：node --import tsx scripts/encoding_test.mjs
 * （若后端在跑，会额外跑一遍「multipart 上传 UTF-16 CSV」的端到端断言）
 *
 * 背景：parse.ts 与后端 datasets.ts 曾只尝试 utf-8 → gbk。
 * Excel「另存为 → 文本文件(Unicode)」和记事本另存为都会产出 UTF-16LE + BOM，
 * 这类文件会走 GBK 兜底被整份解成乱码，列头全部失配、导入直接失败。
 * 现在统一走 shared/encoding.ts 的 decodeBytes（BOM 探测 → UTF-8 严格 → GBK → 兜底）。
 */
import { decodeBytes } from '../packages/shared/src/encoding.ts';
import { decodeFile, parseCsvFile } from '../packages/frontend/src/importer/parse.ts';
import { installAutoCleanup } from './lib-test-utils.mjs';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

const CSV = '时间,实体,数值\n2024,北京,100\n2025,上海,200';

// 1) UTF-8 无 BOM
{
  const t = decodeBytes(Buffer.from(CSV, 'utf8'));
  assert(t === CSV, 'UTF-8 无 BOM 原样解出');
}
// 2) UTF-8 + BOM（TextDecoder 自动剔除 BOM）
{
  const t = decodeBytes(Buffer.from('\uFEFF' + CSV, 'utf8'));
  assert(t === CSV, 'UTF-8+BOM：BOM 被自动剔除，得到干净内容', JSON.stringify(t.slice(0, 12)));
}
// 3) UTF-16LE + BOM（Excel「Unicode 文本」）
{
  const t = decodeBytes(Buffer.from('\uFEFF' + CSV, 'utf16le'));
  assert(t === CSV, 'UTF-16LE+BOM 正确解出（无乱码、BOM 已剔除）', JSON.stringify(t.slice(0, 20)));
}
// 4) UTF-16BE + BOM
{
  const le = Buffer.from('\uFEFF' + CSV, 'utf16le');
  le.swap16();
  const t = decodeBytes(le);
  assert(t === CSV, 'UTF-16BE+BOM 正确解出', JSON.stringify(t.slice(0, 20)));
}
// 5) GBK 无 BOM（「时间,A\n2024,10\n」的 GBK 字节）
{
  const gbk = Buffer.concat([
    Buffer.from([0xca, 0xb1, 0xbc, 0xe4, 0x2c, 0x41, 0x0a]),
    Buffer.from('2024,10\n', 'utf8'),
  ]);
  const t = decodeBytes(gbk);
  assert(t.startsWith('时间,A'), 'GBK 无 BOM 正确解出（utf-8 严格失败后转 gbk）', JSON.stringify(t.slice(0, 10)));
}
// 6) 非法字节流：不能抛错（兜底替换）
{
  const bad = Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0xff, 0xe0]); // 形似 UTF-16 BOM 的二进制
  let threw = false, out = '';
  try { out = decodeBytes(bad); } catch { threw = true; }
  assert(!threw && typeof out === 'string', '无法识别的内容不抛错（兜底为字符串）', `threw=${threw}`);
}

// 7) 前端入口 decodeFile：UTF-16 文件 → 无 BOM 残留 + 能正常解析列头
{
  const bytes = Buffer.from('\uFEFF' + CSV, 'utf16le');
  const file = new File([bytes], 'unicode.csv', { type: 'text/csv' });
  const text = await decodeFile(file);
  const table = parseCsvFile(text);
  assert(table.fields[0] === '时间' && table.fields[1] === '实体' && table.fields[2] === '数值',
    'decodeFile(UTF-16 CSV) → 列头正确、无 BOM 残留',
    JSON.stringify(table.fields));
  assert(table.rows.length === 2 && table.rows[0][1] === '北京',
    'decodeFile(UTF-16 CSV) → 数据行正确',
    JSON.stringify(table.rows[0]));
}

// 8) 若后端在跑：multipart 上传 UTF-16 CSV 端到端
{
  let base = null;
  try {
    const { getBackendPort } = await import('./lib-port.mjs');
    base = `http://127.0.0.1:${getBackendPort()}/api/v1`;
    const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    if (!h.ok) base = null;
  } catch { base = null; }

  if (!base) {
    console.log(`${YEL}ⓘ${RST} 后端未运行，跳过 multipart 端到端断言（跑 e2e 前请先启动后端）`);
  } else {
    // 本次新建的项目在结束时自动清掉（断言失败 / 崩溃同样会清）
    const cleanup = await installAutoCleanup(base);
    const pj = await (await fetch(`${base}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'UTF-16 导入' }),
    })).json();
    const pid = pj.data.id;
    const bytes = Buffer.from('\uFEFF' + CSV, 'utf16le');
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'text/csv' }), 'unicode.csv');
    const up = await fetch(`${base}/projects/${pid}/datasets/upload`, { method: 'POST', body: fd });
    const upJson = await up.json().catch(() => ({}));
    assert(up.status === 201, '后端 multipart 接受 UTF-16 CSV（201）',
      `status=${up.status} err=${upJson.error?.message}`);
    const ds = await (await fetch(`${base}/projects/${pid}/datasets`)).json();
    const rows = ds.data?.series ?? [];
    assert(rows.length === 2 && rows.every(r => r.entity && r.value > 0),
      '后端解析 UTF-16 CSV → 2 行（2 时间点 × 1 实体）数值正常',
      JSON.stringify(rows.slice(0, 2)));
    await cleanup();
  }
}

console.log(`\n编码解码回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
