#!/usr/bin/env node
/**
 * BOM 专项 #2：multipart CSV 长表上传的 BOM 处理
 * 修复内容：parseLongCsv 不剥 BOM 时，UTF-8 CSV 头列变成 "\uFEFF时间"，
 * 触发 pickCol(['时间']) 全部失配，导入以 E_CSV_PARSE 报错。
 * 期望：上传 \uFEFF 开头的 UTF-8 CSV 也能成功导入。
 */
import { getBackendPort } from './lib-port.mjs';
const BASE = `http://127.0.0.1:${getBackendPort()}/api/v1`;

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}
async function req(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, init);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

// 创建测试项目
const { body: p } = await req('POST', '/projects', { title: 'BOM-CSV-multipart' });
const pid = p.data.id;

// 1. 上传带 BOM 的 UTF-8 CSV（Excel 另存的标准场景）
const csvBom = '\uFEFF时间,实体,数值\n2024,Alpha,10\n2024,Beta,20\n2025,Alpha,15\n2025,Beta,25';
const csvBytes = new TextEncoder().encode(csvBom);
const fd = new FormData();
fd.append('file', new Blob([csvBytes], { type: 'text/csv' }), 'bom.csv');
const upResp = await fetch(`${BASE}/projects/${pid}/datasets/upload`, { method: 'POST', body: fd });
const upBody = await upResp.json().catch(() => ({}));

assert(upResp.status === 201, 'BOM CSV multipart 上传成功',
  `status=${upResp.status}, err=${upBody.error?.message}`);

// 2. 读回 series，确认数据被正常解析
const getResp = await fetch(`${BASE}/projects/${pid}/datasets`);
const getJson = await getResp.json();
const rows = getJson.data?.series ?? getJson.data ?? [];

assert(Array.isArray(rows) && rows.length === 4,
  '读回 4 行（2 年 × 2 实体）',
  `实际 ${rows.length} 行`);

// 3. 最关键的：BOM 残留检查
const hasBom = rows.some(r =>
  r.time_key?.includes('\uFEFF') ||
  r.entity?.includes('\uFEFF') ||
  Object.keys(r).some(k => k.includes('\uFEFF'))
);
assert(!hasBom, '读回数据无 \uFEFF BOM 残留', hasBom ? '发现 BOM 残留' : '');

// 4. 验证列名/值正确（不是乱码 → 说明 UTF-8 路径正确，不是 GBK 兜底）
assert(rows.every(r => r.time_key && r.entity && r.value > 0),
  `4 行全部 time/entity/value 有效: ${rows.map(r => `${r.entity}@${r.time_key}=${r.value}`).join(', ')}`);

// 5. 也覆盖 summary 端点
const sumResp = await fetch(`${BASE}/projects/${pid}/datasets/summary`);
const sumJson = await sumResp.json();
assert(sumResp.status === 200 && sumJson.data?.entityCount === 2 && sumJson.data?.timeCount === 2,
  'summary 端点返回 entityCount=2 timeCount=2',
  `status=${sumResp.status} body=${JSON.stringify(sumJson.data)}`);

// 清理
await req('DELETE', `/projects/${pid}`);

console.log(`\nBOM-multipart 专项：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
