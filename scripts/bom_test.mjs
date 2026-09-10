#!/usr/bin/env node
/**
 * BOM 专项：验证后端 importService 对 time_key / entity 中残留 BOM 已剥离
 * （修复方案 §9：BOM 探测 → UTF-8 严格 → GBK → 兜底替换）
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

const { body: p } = await req('POST', '/projects', { title: 'BOM 专项' });
const pid = p.data.id;

// 1. time_key 残留 BOM 字符串（模拟前端 bug：表头 \uFEFF时间 没去 BOM 时用户在前端看不见映射失败）
const r1 = await req('POST', `/projects/${pid}/datasets/import`, {
  rows: [
    { time_key: '\uFEFF2024', entity: '\uFEFFAlpha', value: 10 },  // 双 BOM
    { time_key: '2024', entity: 'Beta', value: 20 },
  ],
});
assert(r1.status === 201 && r1.body.data.imported === 2, 'BOM 污染的 time_key/entity 被清洗',
  `imported=${r1.body.data.imported}, skipped=${r1.body.data.skipped}`);

const get1 = await req('GET', `/projects/${pid}/datasets`);
assert(get1.status === 200, '读回 OK');
const rows1 = get1.body.data.series ?? get1.body.data;
const hasBom = Array.isArray(rows1) && rows1.some(r =>
  r.time_key.includes('\uFEFF') || r.entity.includes('\uFEFF')
);
assert(!hasBom, '读回数据不含 BOM 残留', hasBom ? '仍含 \uFEFF' : '');

// 2. 实体名应被 trim
const r2 = await req('POST', `/projects/${pid}/datasets/import`, {
  rows: [
    { time_key: ' 2025 ', entity: '  实体  ', value: 100 },
  ],
});
if (r2.status !== 201) {
  console.log('r2 完整响应:', JSON.stringify(r2.body));
  console.log('r2 状态:', r2.status);
}
assert(r2.body.data && r2.body.data.imported === 1, '前后空格被 trim',
  `imported=${r2.body.data?.imported}, skipped=${r2.body.data?.skipped}, err=${r2.body.error?.message}`);

const get2 = await req('GET', `/projects/${pid}/datasets`);
const last = (get2.body.data.series ?? get2.body.data)[0];
assert(last && last.time_key === '2025' && last.entity === '实体',
  `time_key='${last.time_key}', entity='${last.entity}'`);

// 清理
await req('DELETE', `/projects/${pid}`);

console.log(`\nBOM 专项：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
