#!/usr/bin/env node
/**
 * 渲染布局回归：engine.draw 的版面度量与配色容量
 *
 * 运行：node --import tsx scripts/render_layout_test.mjs
 *
 * 覆盖两个曾经出问题、且只能通过"跑一遍真实 draw"才能发现的点：
 *  1) 行高/条高的跨帧稳定性 —— engine 曾用 frame.bars.length 当布局基准，
 *     数据稀疏的时间点并集变小 → rowH 突变 → 整组条形粗细与 y 位置跳动。
 *  2) 配色容量 —— 调色板每套只有 18 色而 maxBars 可达 50，
 *     直接取模会让第 19 个起的实体与前面撞色（同屏两个一模一样的柱）。
 */
import { buildDataset, interpolate } from '../packages/frontend/src/renderer/frames.ts';
import { renderer } from '../packages/frontend/src/renderer/engine.ts';
import { getPalette, makeColorOf } from '../packages/frontend/src/renderer/palettes.ts';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

/** 记录 fill()/stroke() 路径的最小 2D context */
function makeMockCtx() {
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    _path: [], _fills: [], _strokes: [],
    fillRect() {},
    beginPath() { ctx._path = []; },
    moveTo(x, y) { ctx._path.push([x, y]); },
    lineTo(x, y) { ctx._path.push([x, y]); },
    arcTo(x1, y1, x2, y2) { ctx._path.push([x1, y1], [x2, y2]); },
    closePath() {},
    fill() { ctx._fills.push(ctx._path.slice()); },
    stroke() { ctx._strokes.push(ctx._path.slice()); },
    fillText() {},
    measureText(t) { return { width: String(t).length * 12 }; },
    save() {}, restore() {},
  };
  return ctx;
}

const CFG = {
  title: '', subtitle: '', sourceNote: '', maxBars: 15, secondsPerStep: 1, headHold: 0.5, tailHold: 0.5,
  palette: 'flat', showValues: false, valueDecimals: 0, showRank: false, timeLabelPos: 'none',
  timeLabelMode: 'step', fontScale: 1, background: '#ffffff',
  width: 1920, height: 1080, fps: 30, videoBitsPerSecond: 8_000_000,
};

function barGeom(ds, orderF, cfg = CFG) {
  const ctx = makeMockCtx();
  const frame = interpolate(ds, orderF, cfg.maxBars);
  const palette = getPalette(cfg.palette);
  renderer.draw(frame, {
    width: cfg.width, height: cfg.height, config: cfg, palette,
    colorOf: makeColorOf(ds.entities, palette), dataset: ds,
  }, ctx);
  // 条形 = fill() 且路径点数 > 4（圆角矩形 8 点）；网格/基线 = stroke()
  const bars = ctx._fills.filter(p => p.length > 4).map(p => {
    const ys = p.map(q => q[1]);
    return { h: Math.max(...ys) - Math.min(...ys) };
  });
  return { shown: frame.bars.length, count: bars.length, barH: bars[0]?.h ?? 0 };
}

// ─── 1) 行高/条高跨帧稳定 ───
// 数据集：t0 有 20 个实体，t1/t2 只有同一批 5 个（模拟数据稀疏的年份）
const pts = [];
for (let i = 0; i < 20; i++) pts.push({ time_key: '2020', time_order: 0, entity: `E${i}`, value: 100 - i });
for (let i = 0; i < 5; i++) pts.push({ time_key: '2021', time_order: 1, entity: `E${i}`, value: 90 - i });
for (let i = 0; i < 5; i++) pts.push({ time_key: '2022', time_order: 2, entity: `E${i}`, value: 80 - i });
const ds = buildDataset(pts);

const dense = barGeom(ds, 0.5); // 并集含 20 个实体
const sparse = barGeom(ds, 1.5); // 并集只有 5 个实体
assert(sparse.shown < dense.shown,
  '稀疏区间 frame.bars 确实变少（复现前提成立）',
  `dense=${dense.shown} sparse=${sparse.shown}`);
assert(Math.abs(dense.barH - sparse.barH) < 0.5,
  '条高跨帧稳定（布局基准不随并集大小变化）',
  `dense=${dense.barH.toFixed(1)}px sparse=${sparse.barH.toFixed(1)}px`);
assert(dense.count === dense.shown && sparse.count === sparse.shown,
  '每条 frame.bars 都被绘制',
  `dense=${dense.count} sparse=${sparse.count}`);

// 实体总数 < maxBars 时按实体数收缩网格（条更饱满），而不是留一排空行
const dsFew = buildDataset([
  ...Array.from({ length: 5 }, (_, i) => ({ time_key: '2020', time_order: 0, entity: `F${i}`, value: 50 - i })),
  ...Array.from({ length: 5 }, (_, i) => ({ time_key: '2021', time_order: 1, entity: `F${i}`, value: 40 - i })),
]);
const few = barGeom(dsFew, 0.5);
assert(few.barH > dense.barH,
  '实体数少于 maxBars 时网格按实体数收缩（条更饱满，不留空行）',
  `few=${few.barH.toFixed(1)}px dense=${dense.barH.toFixed(1)}px`);

// ─── 2) 配色容量 ───
for (const id of ['flat', 'journal', 'dark']) {
  const palette = getPalette(id);
  const ents = Array.from({ length: 50 }, (_, i) => `E${i}`);
  const co = makeColorOf(ents, palette);
  const seen = new Set();
  let dup = 0;
  for (const e of ents) {
    const c = co(e);
    if (seen.has(c)) dup++;
    else seen.add(c);
  }
  assert(dup === 0, `配色「${id}」50 个实体不撞色`, `不同色 ${seen.size} 种，撞色 ${dup} 次`);
}

// 配色稳定性：同一实体重复调用返回同一颜色
{
  const palette = getPalette('flat');
  const co = makeColorOf(['A', 'B', 'C'], palette);
  assert(co('B') === co('B') && co('A') !== co('B'), '同一实体颜色稳定且不同实体不同色');
}

console.log(`\n渲染布局回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
