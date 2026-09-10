/**
 * 多值数据集（multi-value）导入的 e2e 验证
 */
import { getBackendPort } from './lib-port.mjs';
const ROOT = `http://127.0.0.1:${getBackendPort()}/api/v1`;
const RED = '\x1b[31m', GRN = '\x1b[32m', RST = '\x1b[0m';
let pass = 0, fail = 0;

function ok(c, msg, extra = '') {
  if (c) { pass++; console.log(`${GRN}\u2713${RST} ${msg}`); }
  else { fail++; console.log(`${RED}\u2717${RST} ${msg} ${extra ? '\u2014 ' + extra : ''}`); }
}

async function req(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`${ROOT}${path}`, init);
  let data;
  try { data = await r.json(); } catch { data = {}; }
  return { status: r.status, body: data };
}

// 1) 创建项目
const create = await req('POST', '/projects', { title: 'multi-test-' + Date.now() });
ok(create.status === 201 && create.body.data?.id, `建项目 (#${create.body.data?.id})`);
const pid = create.body.data.id;

// 2) 单值导入（向后兼容）
const single = await req('POST', `/projects/${pid}/datasets/import`, {
  rows: [
    { time_key: '1990', entity: '北京', value: 100 },
    { time_key: '1991', entity: '北京', value: 120 },
    { time_key: '1990', entity: '上海', value: 90 },
    { time_key: '1991', entity: '上海', value: 110 },
  ],
});
ok(single.status === 201, '单值导入 201', `code=${single.body.error?.code}`);
ok(single.body.data?.valueColumns?.length === 1 && single.body.data.valueColumns[0] === 'value',
  '单值导入后 valueColumns = [value]',
  JSON.stringify(single.body.data?.valueColumns));

const summary1 = await req('GET', `/projects/${pid}/datasets/summary`);
ok(summary1.body.data?.valueColumns?.[0] === 'value', 'summary.valueColumns 反映单值');

// 3) 多值导入
const multi = await req('POST', `/projects/${pid}/datasets/import-multi`, {
  rows: [
    { time_key: '1990', entity: '北京', values: { 原始: 100, 插值: 100, 填补: 100 } },
    { time_key: '1991', entity: '北京', values: { 原始: 120, 插值: 125, 填补: 130 } },
    { time_key: '1992', entity: '北京', values: { 原始: null, 插值: 140, 填补: 150 } },
    { time_key: '1990', entity: '上海', values: { 原始: 90, 插值: 90, 填补: 90 } },
    { time_key: '1991', entity: '上海', values: { 原始: 110, 插值: 115, 填补: 120 } },
    { time_key: '1992', entity: '上海', values: { 原始: null, 插值: 130, 填补: 140 } },
  ],
  valueColumns: ['原始', '插值', '填补'],
  defaultValueColumn: '插值',
});
ok(multi.status === 201, '多值导入 201', `status=${multi.status} err=${JSON.stringify(multi.body.error)}`);
ok(Array.isArray(multi.body.data?.valueColumns) && multi.body.data.valueColumns.length === 3,
  '多值导入返回 valueColumns 含 3 列',
  JSON.stringify(multi.body.data?.valueColumns));
ok(multi.body.data?.defaultValueColumn === '插值', 'defaultValueColumn 正确');

const summary2 = await req('GET', `/projects/${pid}/datasets/summary`);
ok(summary2.body.data?.valueColumns?.length === 3, 'summary.valueColumns 含 3 列',
  JSON.stringify(summary2.body.data?.valueColumns));
ok(summary2.body.data?.activeValueColumn === '插值', 'summary.activeValueColumn = 插值');
ok(summary2.body.data?.missingValues >= 2, 'summary.missingValues 含空值计数',
  `missingValues=${summary2.body.data?.missingValues}`);

// 4) GET 默认值列的数据
const series0 = await req('GET', `/projects/${pid}/datasets`);
ok(series0.body.data?.series?.length === 6, 'series 6 行', `len=${series0.body.data?.series?.length}`);
ok(series0.body.data?.valueColumns?.length === 3, 'series 响应含 valueColumns');
ok(series0.body.data?.effectiveValueColumn === '插值', 'effectiveValueColumn = 插值');

const beijing91 = series0.body.data.series.find(s => s.time_key === '1991' && s.entity === '北京');
ok(beijing91?.values && '原始' in beijing91.values && '插值' in beijing91.values && '填补' in beijing91.values,
  '北京 1991 values 含三列',
  JSON.stringify(beijing91?.values));
ok(beijing91?.values?.['插值'] === 125, 'values["插值"]=125');
ok(beijing91?.values?.['填补'] === 130, 'values["填补"]=130');

const beijing92 = series0.body.data.series.find(s => s.time_key === '1992' && s.entity === '北京');
ok(beijing92?.values?.['原始'] === null, '北京 1992 原始 = null');

// 5) 切换 valueColumn
const seriesFilled = await req('GET', `/projects/${pid}/datasets?valueColumn=%E5%A1%AB%E8%A1%A5`);
ok(seriesFilled.body.data?.effectiveValueColumn === '填补', '切到 填补');
const beijing91Filled = seriesFilled.body.data.series.find(s => s.time_key === '1991' && s.entity === '北京');
ok(beijing91Filled?.value === 130, 'series.value 跟随填补=130', `value=${beijing91Filled?.value}`);
const beijing92Filled = seriesFilled.body.data.series.find(s => s.time_key === '1992' && s.entity === '北京');
ok(beijing92Filled?.value === 150, '切填补后 1992 北京 = 150');

const seriesOrig = await req('GET', `/projects/${pid}/datasets?valueColumn=%E5%8E%9F%E5%A7%8B`);
ok(seriesOrig.body.data?.effectiveValueColumn === '原始', '切回 原始');
const beijing92Orig = seriesOrig.body.data.series.find(s => s.time_key === '1992' && s.entity === '北京');
ok(beijing92Orig?.value === 0, '原始列空值=0');

const series2 = await req('GET', `/projects/${pid}/datasets?valueColumn=%E6%8F%92%E5%80%BC`);
ok(series2.body.data?.series.find(s => s.entity === '北京' && s.time_key === '1992')?.value === 140,
  '切插值后 1992 北京 = 140');

// 6) PATCH 保存 valueColumn
const projGet = await req('GET', `/projects/${pid}`);
const cfg = projGet.body.data.config;
const patch = await req('PATCH', `/projects/${pid}`, {
  config: { ...cfg, valueColumn: '填补' },
});
ok(patch.status === 200, 'PATCH 200');
ok(patch.body.data?.config?.valueColumn === '填补', 'PATCH 后 cfg.valueColumn = 填补');

// 7) 无效 valueColumn → 退回 activeValueColumn
const seriesJunk = await req('GET', `/projects/${pid}/datasets?valueColumn=NOT_EXIST`);
ok(seriesJunk.body.data?.effectiveValueColumn === '填补', '无效值列→退回');

// 8) 错误：空 rows
const empty = await req('POST', `/projects/${pid}/datasets/import-multi`, {
  rows: [],
  valueColumns: ['原始'],
});
ok(empty.status === 400 || empty.body.error?.code === 'E_EMPTY_TIMESERIES',
  '空 rows → 400 / E_EMPTY_TIMESERIES');

// 9) 错误：valueColumns 空
const noCols = await req('POST', `/projects/${pid}/datasets/import-multi`, {
  rows: [{ time_key: '1990', entity: 'X', values: { a: 1 } }],
  valueColumns: [],
});
ok(noCols.status === 400, 'valueColumns 空 → 400');

// 10) 删除
const del = await req('DELETE', `/projects/${pid}`);
ok(del.status === 204 || del.status === 200, '删除项目');

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
