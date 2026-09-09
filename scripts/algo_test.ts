#!/usr/bin/env node
/**
 * 算法/解析层测试（直接用 tsx 加载 TS 源，覆盖关键边界）：
 *  - frames.buildDataset / interpolate / progressToOrderF / totalDuration
 *  - parse.parseDelimitedText / decodeFile / guessMapping / toLongRows / stripBOM
 */
import { buildDataset, interpolate, progressToOrderF, totalDuration, ease, niceStepFromMax, computeScale } from '../packages/frontend/src/renderer/frames.ts';
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

// ========== 增强：prevRank/nextRank/opacity 让排名切换位置插值 ==========
console.log('\n\x1b[1m=== frames.ts 排名位置插值（增强） ===\x1b[0m');

// 数据：A 与 B 第二个时间点换位（B 第 2 → 第 1）
//    time 0: A=100/B=50 → A 第 1，B 第 2
//    time 1: A=80 /B=70 → A 第 1，B 第 2
//    time 2: A=60 /B=90 → B 第 1，A 第 2
const dsRace = buildDataset([
  pt({ time_key: '2020', time_order: 0, entity: 'A', value: 100 }),
  pt({ time_key: '2020', time_order: 0, entity: 'B', value: 50 }),
  pt({ time_key: '2021', time_order: 1, entity: 'A', value: 80 }),
  pt({ time_key: '2021', time_order: 1, entity: 'B', value: 70 }),
  pt({ time_key: '2022', time_order: 2, entity: 'A', value: 60 }),
  pt({ time_key: '2022', time_order: 2, entity: 'B', value: 90 }),
]);

// 在交换点之前（orderF=0.99，刚好 step 1 起点 t=0）：两端都在榜，无交叉
const fBefore = interpolate(dsRace, 0.99, 10);
const aBefore = fBefore.bars.find(b => b.entity === 'A')!;
const bBefore = fBefore.bars.find(b => b.entity === 'B')!;
assert(aBefore.prevRank === 1 && bBefore.prevRank === 2,
  'rank 反超点之前：prev 帧 A=1, B=2',
  `A=${aBefore.prevRank}, B=${bBefore.prevRank}`);
assert(aBefore.nextRank === 1 && bBefore.nextRank === 2,
  'rank 反超点之前：next 帧 A=1, B=2（orderF=0.99 仍在 step 0→1 内）',
  `A=${aBefore.nextRank}, B=${bBefore.nextRank}`);
assert(aBefore.opacity === 1 && bBefore.opacity === 1,
  'rank 反超点之前：两端都在榜 → opacity 均为 1',
  `A=${aBefore.opacity}, B=${bBefore.opacity}`);

// 在步切换刚开始（orderF=1.01，t=0.01 在 step 1→2）：
//   prev=time1: A=80/B=70 → A 第 1，B 第 2
//   next=time2: A=60/B=90 → B 第 1，A 第 2  ← 在跨入点 nextRank 已变
const fAfter = interpolate(dsRace, 1.01, 10);
const aAfter = fAfter.bars.find(b => b.entity === 'A')!;
const bAfter = fAfter.bars.find(b => b.entity === 'B')!;
assert(aAfter.prevRank === 1 && aAfter.nextRank === 2,
  '跨入反超点后：A 的 next 帧 rank 已是 2（被 B 超越的目标态）',
  `A=${JSON.stringify({prevRank: aAfter.prevRank, nextRank: aAfter.nextRank})}`);
assert(bAfter.prevRank === 2 && bAfter.nextRank === 1,
  '跨入反超点后：B 的 next 帧 rank 已是 1（超越 A 的目标态）',
  `B=${JSON.stringify({prevRank: bAfter.prevRank, nextRank: bAfter.nextRank})}`);
assert(aAfter.opacity === 1 && bAfter.opacity === 1,
  '排名反超中（两端都在榜）：opacity=1（让位置插值主导观感）',
  `A=${aAfter.opacity}, B=${bAfter.opacity}`);

// progress 字段：in-range ease(0.01)=~0.0004，跨入点应非常接近 0 不接近 1
assert(fAfter.progress >= 0 && fAfter.progress < 0.05,
  'progress 是 eased(0.01) ≈ 0（位置 lerp 仍贴近 prev 端）',
  `progress=${fAfter.progress}`);

// 在 t=0.5（orderF=1.5）时：A=70, B=80 → B 已经排第 1
const fMid = interpolate(dsRace, 1.5, 10);
const aMid = fMid.bars.find(b => b.entity === 'A')!;
const bMid = fMid.bars.find(b => b.entity === 'B')!;
assert(aMid.rank === 2 && bMid.rank === 1, 'orderF=1.5：rank 已显示 B 第 1（按当前 union 值排序）',
  `A.rank=${aMid.rank}, B.rank=${bMid.rank}`);

// ★ 新晋 entity：C 只在 time 2 出现，首次上榜应带"虚拟榜外" + opacity 淡入
const dsEnter = buildDataset([
  pt({ time_key: '2020', time_order: 0, entity: 'A', value: 100 }),
  pt({ time_key: '2020', time_order: 0, entity: 'B', value: 50 }),
  pt({ time_key: '2021', time_order: 1, entity: 'A', value: 80 }),
  pt({ time_key: '2021', time_order: 1, entity: 'B', value: 70 }),
  pt({ time_key: '2022', time_order: 2, entity: 'A', value: 60 }),
  pt({ time_key: '2022', time_order: 2, entity: 'B', value: 90 }),
  pt({ time_key: '2022', time_order: 2, entity: 'C', value: 40 }), // C 仅出现 1 次
]);
const maxBarsN = 5;
const OFF = maxBarsN + 1;
const fEnter = interpolate(dsEnter, 1.5, maxBarsN);
const cEnter = fEnter.bars.find(b => b.entity === 'C');
assert(cEnter != null, '新晋 C 应在 union（并集）出现');
assert(cEnter!.prevRank === OFF, '新晋 entity：prev frame 不在 top → prevRank=OFF（虚拟榜外）',
  `C.prevRank=${cEnter!.prevRank}`);
assert(cEnter!.nextRank !== OFF, '新晋 entity：next frame 在 top → nextRank 为正整数',
  `C.nextRank=${cEnter!.nextRank}`);
assert(Math.abs(cEnter!.opacity - 0.5) < 0.05,
  '新晋 entity 在 t=0.5：opacity≈0.5（线性从 0 到 1 淡入）',
  `C.opacity=${cEnter!.opacity}`);

// ★ 离场 entity：D 在 time 0 / time 1 都第 1，time 2 不再上榜
const dsExit = buildDataset([
  pt({ time_key: '2020', time_order: 0, entity: 'A', value: 50 }),
  pt({ time_key: '2020', time_order: 0, entity: 'B', value: 30 }),
  pt({ time_key: '2020', time_order: 0, entity: 'D', value: 200 }),
  pt({ time_key: '2021', time_order: 1, entity: 'A', value: 80 }),
  pt({ time_key: '2021', time_order: 1, entity: 'B', value: 70 }),
  pt({ time_key: '2021', time_order: 1, entity: 'D', value: 150 }), // D 在 step 1→2 起点还有
  pt({ time_key: '2022', time_order: 2, entity: 'A', value: 60 }),
  pt({ time_key: '2022', time_order: 2, entity: 'B', value: 90 }),
  // D 在 time 2 已不出现 → 下榜
]);
const fExit = interpolate(dsExit, 1.5, 5);
const dExit = fExit.bars.find(b => b.entity === 'D');
assert(dExit != null, '离场 D 仍在 union（prev 帧排前）');
assert(dExit!.prevRank === 1,
  '离场 D：prev frame D=150 仍排第 1 → prevRank=1',
  `D.prevRank=${dExit!.prevRank}`);
assert(dExit!.nextRank === 6,
  '离场 D：next frame 不在 top → nextRank=6（maxBars+1）',
  `D.nextRank=${dExit!.nextRank}`);
assert(Math.abs(dExit!.opacity - 0.5) < 0.05,
  '离场 D 在 t=0.5：opacity≈0.5（线性从 1 减到 0）',
  `D.opacity=${dExit!.opacity}`);

// 边界：t=1（步切换尾点）：离场 → opacity=0
const fExitEnd = interpolate(dsExit, 1.999, 5);
const dAtEnd = fExitEnd.bars.find(b => b.entity === 'D');
assert(dAtEnd != null && Math.abs(dAtEnd!.opacity) < 0.05,
  '离场 D 在 t≈1：opacity≈0（完全淡出）',
  `D.opacity=${dAtEnd!.opacity}`);

// 边界：t=0（步切换起点）：入场 → opacity=0
const fEnterStart = interpolate(dsEnter, 1.0, maxBarsN);
const cAtStart = fEnterStart.bars.find(b => b.entity === 'C');
assert(cAtStart != null && Math.abs(cAtStart!.opacity) < 0.01,
  '新晋 C 在 t=0：opacity=0（完全透明，无视觉抖动）',
  `C.opacity=${cAtStart!.opacity}`);

// buildDataset.maxAbs：用于 axisStep 全局比例尺
assert(dsRace.maxAbs === 100, 'buildDataset.maxAbs 取所有 value 的最大绝对值',
  `got=${dsRace.maxAbs}`);
assert(buildDataset([]).maxAbs === 0, '空数据集 maxAbs=0');

// ========== niceStepFromMax / computeScale：用户可控数轴步幅 ==========
console.log('\n\x1b[1m=== frames.ts 数轴 step 与 scaleMax ===\x1b[0m');

// niceStep 自适应（auto 模式）：maxAbs 落在 1×10^k / 2×10^k / 5×10^k 的就近档
// 公式 raw = maxAbs / targetTicks；按 raw/base 比例 1/2/5 取就近
assert(niceStepFromMax(950, 5) === 100, 'maxAbs=950 → raw=190 → step=200（ratio 1.9 → 2，base 100）',
  `got=${niceStepFromMax(950, 5)}`);
assert(niceStepFromMax(1900, 5) === 200, 'maxAbs=1900 → raw=380 → step=200（ratio 3.8 → 2，base 100）',
  `got=${niceStepFromMax(1900, 5)}`);
assert(niceStepFromMax(4500, 5) === 500, 'maxAbs=4500 → raw=900 → step=500（ratio 9 → 5，base 100）',
  `got=${niceStepFromMax(4500, 5)}`);
assert(niceStepFromMax(9500, 5) === 1000, 'maxAbs=9500 → raw=1900 → step=1000（ratio 1.9 < 2 → 1，base 1000）',
  `got=${niceStepFromMax(9500, 5)}`);
assert(niceStepFromMax(45000, 5) === 5000, 'maxAbs=45000 → raw=9000 → step=5000（ratio 9 → 5，base 1000）',
  `got=${niceStepFromMax(45000, 5)}`);

// 用户指定 axisStep：scaleMax 必须按 step 向上取整，且刻度按 step 等分
const s1 = computeScale(9500, 1000);
assert(s1.scaleMax === 10000, 'axisStep=1000, maxAbs=9500 → scaleMax=10000（向上取整 10 × step）',
  `got=${s1.scaleMax}`);
assert(s1.step === 1000, 'axisStep=1000：返回 step=1000',
  `got=${s1.step}`);
assert(s1.ticks.includes(0) && s1.ticks[s1.ticks.length - 1] === s1.scaleMax,
  'ticks 必须含 0 与 scaleMax',
  JSON.stringify(s1.ticks));
assert(s1.ticks.length >= 3, 'ticks 至少 3 个（避免单步幅过密或过稀）',
  `count=${s1.ticks.length}`);
assert(s1.ticks.length <= 9, 'ticks 最多 9 个端点（8 个等分区间）',
  `count=${s1.ticks.length}`);

// auto 模式（axisStep ≤ 0）：保持旧行为 — scaleMax = maxAbs × 1.05
const sAuto = computeScale(1000, 0);
assert(Math.abs(sAuto.scaleMax - 1050) < 1e-6, 'auto：scaleMax = maxAbs × 1.05（兼容旧行为）',
  `got=${sAuto.scaleMax}`);

// 极大轴步幅：scaleMax 仍有效（无 inf）
const sHuge = computeScale(1e6, 50000);
assert(Number.isFinite(sHuge.scaleMax) && sHuge.scaleMax >= 1e6,
  '极大 step 不溢出：scaleMax 是有限数且 ≥ maxAbs',
  `got=${sHuge.scaleMax}`);

// maxBars=0 / maxAbs=0：防御
const sDef = computeScale(0, 0);
assert(sDef.scaleMax > 0, 'maxAbs=0 时 scaleMax 兜底 > 0',
  `got=${sDef.scaleMax}`);


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

// ★ 省份代码防御（2026-09-09 真 bug 回归）：
// 政府统计 xlsx 常见 [年份, 省份, 省份代码, 人均消费支出(元)]。
// 旧版兜底逻辑按"数值比例最高"选 value，「省份代码」(100% 数字但恒定) 会击败
// 有空值的真实统计列 → 条形图一动不动、只有时间标签在走。
const govTable = {
  fields: ['年份', '省份', '省份代码', '城镇居民人均消费支出(元)'],
  rows: [
    ['1990', '北京市', '110000', '1646'],
    ['1991', '北京市', '110000', '1748'],
    ['1990', '上海市', '310000', '1937'],
    ['1991', '上海市', '310000', '2167'],
    ['1990', '广东省', '440000', '1984'],
    ['1991', '广东省', '440000', '2310'],
  ],
  source: 'text' as const,
};
const mGov = guessMapping(govTable as any);
assert(mGov && mGov.time === '年份' && mGov.entity === '省份',
  '省份列被识别为 entity（别名扩充）',
  JSON.stringify(mGov));
assert(mGov?.value === '城镇居民人均消费支出(元)',
  '★ 省份代码不再被误选为 value（标识列防御）',
  `value=${mGov?.value}`);
assert(!mGov?.valueCandidates?.includes('省份代码'),
  'valueCandidates 也不含省份代码',
  JSON.stringify(mGov?.valueCandidates));
const govLong = toLongRows(govTable as any, 'long', mGov ?? undefined);
assert(govLong.rows.length === 6 && govLong.rows[0].value === 1646,
  '政府表转换：value 是消费支出而非代码',
  JSON.stringify(govLong.rows[0]));

console.log(`\n${pass} 通过, ${fail} 失败`);
if (fail) failList.forEach(f => console.log('  - ' + f));
process.exit(fail ? 1 : 0);
