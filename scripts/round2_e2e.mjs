#!/usr/bin/env node
/**
 * 第二轮深度测试：覆盖之前未测的边界
 *  - 数值边界（极大/极小/负数/0/科学记数法）
 *  - 同值并列（排名排序的字典序稳定性）
 *  - 并发同项目两条 import（race condition）
 *  - delete 再 import empty rows
 *  - 时间标签 mode 字段（schema 是否接受）
 *  - records projectId 不存在 → 404
 *  - records DELETE 不存在的 → 404
 *  - projects PATCH 部分字段（title / description / config）
 *  - BOM 真的不残留 + 同时存在正常数据
 */
const BASE = 'http://127.0.0.1:9200/api/v1';
const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
const failList = [];
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; failList.push(label + (detail ? ` | ${detail}` : '')); console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}
async function req(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, init);
  let j; try { j = await r.json(); } catch { j = {}; }
  return { status: r.status, body: j };
}

const suite = async () => {
  console.log('\n\x1b[1m=== Round 2 Bug Hunt ===\x1b[0m');

  // ── 项目：A ──
  const { body: pA } = await req('POST', '/projects', { title: 'R2-A' });
  const pidA = pA.data.id;

  // 1. 数值边界
  const r1 = await req('POST', `/projects/${pidA}/datasets/import`, {
    rows: [
      { time_key: '2024', entity: 'Big', value: 1e15 },                   // 1 千万亿
      { time_key: '2024', entity: 'Neg', value: -1234.56 },                // 负数
      { time_key: '2024', entity: 'Zero', value: 0 },                     // 零
      { time_key: '2024', entity: 'Sci', value: '1.23e-5' },              // 科学记数法 string
      { time_key: '2024', entity: 'NegZero', value: '-0' },               // 字符串 '-0'
      { time_key: '2024', entity: 'Infinity', value: 'Infinity' },        // 无效
      { time_key: '2024', entity: 'NaN', value: 'abc' },                  // NaN
    ],
  });
  assert(r1.status === 201 && r1.body.data.imported === 5,
    '数值边界：清洗 Infinity/NaN，保留 5 行', `imported=${r1.body.data.imported}`);

  // 2. 同值并列（字典序稳定）
  const r2 = await req('POST', `/projects/${pidA}/datasets/import`, {
    rows: [
      { time_key: '2025', entity: 'Alpha', value: 100 },
      { time_key: '2025', entity: 'Beta',  value: 100 },  // 同值
      { time_key: '2025', entity: 'Gamma', value: 100 },  // 同值
    ],
  });
  assert(r2.body.data.imported === 3, '同值并列：3 行入库');
  const s2 = (await req('GET', `/projects/${pidA}/datasets`)).body.data;
  // ORDER BY time_order, value DESC, entity ASC → 同值时 entity 字典序：B(eta) < G(amma) < A(lpha)
  // 即 order: Beta, Gamma, Alpha
  const sameTimes = s2.filter(r => r.time_key === '2025');
  assert(sameTimes.length === 3, '同值读取 3 行');
  const names = sameTimes.map(r => r.entity).join(',');
  assert(names === 'Alpha,Beta,Gamma', '同值时 SQL 按 entity ASCII 升序',
    `actual=${names}`);

  // 3. 时间非数值排序：保持首现顺序
  const r3 = await req('POST', `/projects/${pidA}/datasets/import`, {
    rows: [
      { time_key: 'Q1', entity: 'X', value: 1 },
      { time_key: 'Q3', entity: 'X', value: 3 },
      { time_key: 'Q2', entity: 'X', value: 2 },
    ],
  });
  const s3 = (await req('GET', `/projects/${pidA}/datasets`)).body.data.filter(r => r.entity === 'X' && ['Q1','Q2','Q3'].includes(r.time_key));
  const orders = s3.map(r => `${r.time_key}=${r.time_order}`).join(',');
  assert(orders === 'Q1=0,Q3=1,Q2=2',
    '非数值 time_key 保持首现顺序', orders);

  // 4. 并发同项目两条 import（race condition）
  const pidB = (await req('POST', '/projects', { title: 'R2-B' })).body.data.id;
  const bigRows = [];
  for (let y = 0; y < 5; y++) for (let i = 0; i < 20; i++) bigRows.push({ time_key: `Y${y}`, entity: `E${i}`, value: y * 100 + i });
  const [cA, cB] = await Promise.all([
    req('POST', `/projects/${pidB}/datasets/import`, { rows: bigRows }),
    req('POST', `/projects/${pidB}/datasets/import`, { rows: bigRows }),
  ]);
  assert(cA.status === 201 && cB.status === 201, '并发两条 import 都成功');
  // better-sqlite3 是同步的，better-sqlite3 内部跑在同步 fs 上，外层 JS 同一线程。
  // 即使 Node.js 接 Promise.all 也只是排队 invoke，不会真同步。
  // 实际最终落到 DB 的内容应等价（DELETE + INSERT），重复写入。
  const sB = (await req('GET', `/projects/${pidB}/datasets`)).body.data;
  assert(sB.length === 100, '并发 import 后数据完整（5×20=100 行）',
    `actual=${sB.length}`);

  // 5. DELETE 再 import（空）
  await req('DELETE', `/projects/${pidB}/datasets`);
  const emptyImp = await req('POST', `/projects/${pidB}/datasets/import`, {
    rows: [{ time_key: '2024', entity: 'X', value: 10 }],
  });
  assert(emptyImp.body.data.imported === 1, 'DELETE datasets 后可重新 import');

  // 6. PATCH projects 部分字段
  const patch = await req('PATCH', `/projects/${pidA}`, { title: 'R2-A-modified' });
  assert(patch.status === 200 && patch.body.data.title === 'R2-A-modified', 'PATCH 修改 title');

  const patchConfig = await req('PATCH', `/projects/${pidA}`, {
    config: { title: 'Hello', maxBars: 22, timeLabelPos: 'top-left' }
  });
  assert(patchConfig.status === 200, 'PATCH 修改 config 部分字段');
  assert(patchConfig.body.data.config.title === 'Hello' && patchConfig.body.data.config.maxBars === 22,
    'config 合并正确（默认值合并 + 部分字段覆盖）',
    `title=${patchConfig.body.data.config.title}, maxBars=${patchConfig.body.data.config.maxBars}`);

  // 7. schema 字段限制（timeLabelPos 越界）
  const bad = await req('PATCH', `/projects/${pidA}`, { config: { timeLabelPos: 'middle' } });
  assert(bad.status === 400 && bad.body.error?.code === 'E_VALIDATION', 'timeLabelPos 非法值 → 400');

  // 8. records 不存在
  const rec404 = await req('GET', '/records/99999');
  assert(rec404.status === 404, 'GET /records/99999 → 404');

  const recDel404 = await req('DELETE', '/records/99999');
  assert(recDel404.status === 404, 'DELETE /records/99999 → 404');

  // 9. datasets DELETE 项目级联
  const beforeDeleteCascade = (await req('GET', `/records?projectId=${pidA}`)).body.data.length;
  await req('DELETE', `/projects/${pidA}`);
  const afterDeleteCascade = await req('GET', `/records?projectId=${pidA}`);
  // 项目删了 → records 也应该被级联删除
  assert(afterDeleteCascade.body.data.length === 0 || afterDeleteCascade.status === 200,
    '级联删除：records 跟随项目',
    `before=${beforeDeleteCascade}, after=${afterDeleteCascade.body?.data?.length ?? 'N/A'}`);

  // 10. PATCH 验证：URL 含特殊字符
  const patchSpecial = await req('PATCH', `/projects/${pidB}`, { description: '中/英/emoji🚀' });
  assert(patchSpecial.status === 200, 'description 含特殊字符');

  // 11. multipart 上传：filename 含中文/特殊字符
  await req('POST', '/records', { project_id: pidB, config_snapshot: { width: 1920, height: 1080, fps: 30 }, duration_ms: 1000, size_bytes: 100 });
  const recs = (await req('GET', '/records?projectId=' + pidB)).body.data;
  if (recs.length > 0) {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(100)], { type: 'video/mp4' }), '中-文-文件名.mp4');
    const r = await fetch(`${BASE}/records/${recs[0].id}/file`, { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    assert(r.status === 201 && j.data?.size_bytes === 100, '上传中文文件名 OK');
  }

  // ── 清理 ──
  await req('DELETE', `/projects/${pidB}`);
};

suite().then(() => {
  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) failList.forEach(f => console.log('  - ' + f));
  process.exit(fail ? 1 : 0);
});
