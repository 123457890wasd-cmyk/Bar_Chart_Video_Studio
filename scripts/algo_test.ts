#!/usr/bin/env node
/**
 * 算法/解析层测试（直接用 tsx 加载 TS 源，覆盖关键边界）：
 *  - frames.buildDataset / interpolate / progressToOrderF / totalDuration
 *  - parse.parseDelimitedText / decodeFile / guessMapping / toLongRows / stripBOM
 */
import { buildDataset, interpolate, progressToOrderF, totalDuration, ease } from '../packages/frontend/src/renderer/frames.ts';
import { parseDelimitedText, guessMapping, toLongRows, stripBOM } from '../packages/frontend/src/importer/parse.ts';
import { SeriesPoint } from '../packages/shared/src/types.ts';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
const failList = [];
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; failList.push(label + (detail ? ` | ${detail}` : '')); console.log(`${RED}✗${RST} ${label}${detail ? '  → ' + YEL + detail + RST : ''}`); }
}

function pt(overrides: Partial<SeriesPoint>): SeriesPoint {
  return { time_key: '2024', time_order: 0, entity: 'X', value: 0, ...overrides } as SeriesPoint;
}

console.log('\n\x1b[1m=== frames.ts 算法 ===\x1b[0m');

// ease(0)=0, ease(1)=1, ease(0.5)=0.5
assert(ease(0) === 0, 'ease(0)=0', String(ease(0)));
assert(ease(1) === 1, 'ease(1)=1', String(ease(1)));
assert(Math.abs(ease(0.5) - 0.5) < 1e-9, 'ease(0.5)=0.5', String(ease(0.5)));

// buildDataset：单时间点
const ds1 = buildDataset([
  pt({ time_key: '2024', time_order: 0, entity: 'A', value: 10 }),
  pt({ time_key: '2024', time_order: 0, entity: 'B', value: 5 }),
]);
assert(ds1.times.length === 1, '单时间点 times.length=1');
assert(ds1.entities.length === 2, 'entities=2');
assert(ds1.numericTimes === true, '单时间点 time_key 可解析为数字 → numericTimes=true',
  `numericTimes=${ds1.numericTimes}`);

const dsEmpty = buildDataset([]);
assert(dsEmpty.times.length === 0, '空数据集 times=0');
assert(interpolate(dsEmpty, 0, 10).bars.length === 0, '空数据 interpolate 返回空 bars');

// buildDataset：多时间点 + numeric 数值
const dsN = buildDataset([
  pt({ time_key: '2020', time_order: 0, entity: 'A', value: 100 }),
  pt({ time_key: '2020', time_order: 0, entity: 'B', value: 50 }),
  pt({ time_key: '2021', time_order: 1, entity: 'A', value: 80 }),
  pt({ time_key: '2021', time_order: 1, entity: 'B', value: 70 }),
  pt({ time_key: '2022', time_order: 2, entity: 'A', value: 60 }),
  pt({ time_key: '2022', time_order: 2, entity: 'B', value: 90 }),
]);
assert(dsN.times.length === 3, '多时间点 times=3');
assert(dsN.numericTimes === true, '所有 time_key 数值 → numericTimes=true');

// interpolate N=1
const f1 = interpolate(dsN, 0, 10);
assert(f1.bars.length === 2, 'N=1 interpolate bars=2');
assert(f1.bars[0].entity === 'A' && f1.bars[0].value === 100, 'N=1 时 A 排第 1',
  JSON.stringify(f1.bars));

// interpolate N>=2：orderF=0 时 t=0
const f0 = interpolate(dsN, 0, 10);
assert(f0.bars.length === 2, 'orderF=0 返回 2 条（两个时间点 top10 并集）');
// A(100) rank=1, B(50) rank=2
assert(f0.bars[0].entity === 'A', 'orderF=0 第 1 名是 A');

// orderF=1.5 (后半段过渡：mapA={A:80,B:70}, mapB={A:60,B:90}, t=0.5)
// → A=lerp(80,60,0.5)=70, B=lerp(70,90,0.5)=80 → B 排第一
const f2 = interpolate(dsN, 1.5, 10);
const aVal = f2.bars.find(b => b.entity === 'A')!.value;
const bVal = f2.bars.find(b => b.entity === 'B')!.value;
assert(Math.abs(aVal - 70) < 1, 'orderF=1.5: A=70 (lerp 80→60 中点)',
  `got=${aVal}`);
assert(Math.abs(bVal - 80) < 1, 'orderF=1.5: B=80 (lerp 70→90 中点)',
  `got=${bVal}`);
assert(f2.bars[0].entity === 'B', 'orderF=1.5 第 1 名是 B',
  JSON.stringify(f2.bars));

// totalDuration
assert(totalDuration(dsN, 0.5, 1, 1) === 1 + (3-1)*0.5 + 1, 'totalDuration 正确',
  `got=${totalDuration(dsN, 0.5, 1, 1)}, expected=3`);

// progressToOrderF 边界
assert(progressToOrderF(dsN, 0, 0.5, 1, 1) === 0, 'p=0 → orderF=0');
assert(progressToOrderF(dsN, 1, 0.5, 1, 1) === 2, 'p=1 → orderF=N-1=2');
assert(progressToOrderF(dsEmpty, 0.5, 0.5, 1, 1) === 0, '空数据 p=0.5 → orderF=0');
assert(progressToOrderF(dsN, 0.5, 0.5, 1, 1) >= 0 && progressToOrderF(dsN, 0.5, 0.5, 1, 1) < 2, 'p=0.5 中段过渡');

console.log('\n\x1b[1m=== importer/parse.ts 解析 ===\x1b[0m');

// stripBOM
assert(stripBOM('\uFEFFhello') === 'hello', 'stripBOM 移除前缀');
assert(stripBOM('hello') === 'hello', 'stripBOM 保留无 BOM');

// parseDelimitedText：简单 CSV
const csv = `时间,实体,数值
2020,A,10
2020,B,20
2021,A,15`;
const t1 = parseDelimitedText(csv);
assert(t1.fields.length === 3 && t1.fields[0] === '时间', 'CSV 解析 header（无 BOM）');
assert(t1.rows.length === 3, 'CSV 解析 3 行');

// parseDelimitedText：BOM CSV（关键 bug 修复点）
const csvBOM = '\uFEFF时间,实体,数值\n2020,A,10';
const t2 = parseDelimitedText(csvBOM);
assert(t2.fields[0] === '时间', 'BOM CSV 解析后字段名不带 BOM',
  `field="${t2.fields[0]}", codes=${[...t2.fields[0]].map(c => c.charCodeAt(0)).join(',')}`);

// TSV 解析
const tsv = `时间\t实体\t数值\n2020\tA\t10`;
const t3 = parseDelimitedText(tsv);
assert(t3.fields.length === 3, 'TSV 解析 header');
assert(t3.rows[0][0] === '2020', 'TSV 第 1 行');

// guessMapping
const m1 = guessMapping(t1);
assert(m1 && m1.time === '时间' && m1.entity === '实体' && m1.value === '数值', 'guessMapping 命中中文列名');

// guessMapping fallback（无明显语义）
const csv2 = `col1,col2,col3\n2020,A,10\n2021,B,20`;
const t4 = parseDelimitedText(csv2);
const m2 = guessMapping(t4);
assert(m2 && m2.time === 'col1' && m2.entity === 'col2' && m2.value === 'col3', 'guessMapping 兜底启发式');

// toLongRows long
const lr = toLongRows(t1, 'long', m1);
assert(lr.rows.length === 3, 'long 模式解析 3 行');
assert(lr.warnings.length === 0, 'long 模式无警告');
assert(lr.errors.length === 0, 'long 模式无错误');

// toLongRows wide-by-row
const wide = `时间,A,B,C
2020,10,20,30
2021,15,18,25`;
const tW = parseDelimitedText(wide);
const w = toLongRows(tW, 'wide-by-row');
assert(w.rows.length === 6, 'wide-by-row: 2 时间 × 3 实体 = 6 行',
  `got=${w.rows.length}`);

// toLongRows wide-by-col
const wideC = `实体,2020,2021,2022
A,10,20,30
B,15,18,25`;
const tWc = parseDelimitedText(wideC);
const wc = toLongRows(tWc, 'wide-by-col');
assert(wc.rows.length === 6, 'wide-by-col: 2 实体 × 3 时间 = 6 行',
  `got=${wc.rows.length}`);

// 数值清洗：宽表含非数值
const wideN = `时间,A,B
2020,10,%
2021,20,30`;
const tWN = parseDelimitedText(wideN);
const wN = toLongRows(tWN, 'wide-by-row');
assert(wN.rows.length === 3 && wN.warnings.length === 1, '宽表含 "%" → 跳过 1 行 + 1 警告',
  `rows=${wN.rows.length}, warnings=${JSON.stringify(wN.warnings)}`);

// 空数据行处理
const csvEmpty = `时间,实体,数值
,  ,
2020,A,10`;
const tE = parseDelimitedText(csvEmpty);
const eRes = toLongRows(tE, 'long', m1);
assert(eRes.rows.length === 1, '空时间/实体行被过滤',
  `rows=${eRes.rows.length}, warnings=${eRes.warnings.length}`);

// Excel 中文版导出 CSV 用全角逗号分隔（真 bug 修复点）
const csvCN = '时间，实体，数值\n2024，公司A，10\n2024，公司B，20';
const tCN = parseDelimitedText(csvCN);
assert(tCN.fields.length === 3 && tCN.fields[0] === '时间', '中文逗号分隔 header',
  `fields=${JSON.stringify(tCN.fields)}`);
assert(tCN.rows[0][1] === '公司A', '中文逗号分隔第二列 entity',
  `cell='${tCN.rows[0][1]}'`);

console.log(`\n${pass} 通过, ${fail} 失败`);
if (fail) failList.forEach(f => console.log('  - ' + f));
process.exit(fail ? 1 : 0);
