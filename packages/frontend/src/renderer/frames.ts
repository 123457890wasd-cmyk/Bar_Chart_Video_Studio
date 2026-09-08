/**
 * 帧序列构建与插值算法 —— 技术方案 §5.2 / §6.1 实现必读
 *
 * 抖动规避的本质（方案原文）：
 * 「长度插值」产生平滑增长，而「Y 由插值后的值实时排序决定」；
 * 条数变化瞬间的整组跳变，靠"相邻两步取并集 + 0 值补位"解决。
 */
import type { SeriesPoint } from '@barstudio/shared';

export interface TimePoint {
  order: number;
  label: string;
}

export interface Dataset {
  /** 按 order 升序 */
  times: TimePoint[];
  /** order -> (entity -> value) */
  values: Map<number, Map<string, number>>;
  /** 实体（按首次出现顺序，用于稳定配色分配） */
  entities: string[];
  /** 全部 time_key 是否均为数值（决定 continuous 时间标签可用性） */
  numericTimes: boolean;
}

export interface BarState {
  entity: string;
  value: number;
  rank: number;
}

export interface InterpFrame {
  /** 当前步标签（step 模式用，过渡中点切换） */
  timeLabel: string;
  /** 数值插值标签（continuous 模式用；时间点非数值时为 null） */
  timeLabelCont: string | null;
  bars: BarState[];
}

export function buildDataset(points: SeriesPoint[]): Dataset {
  const values = new Map<number, Map<string, number>>();
  const times = new Map<number, string>();
  const entities: string[] = [];
  const entitySet = new Set<string>();
  const numericKeys: string[] = [];

  for (const p of points) {
    if (!times.has(p.time_order)) times.set(p.time_order, p.time_key);
    if (!values.has(p.time_order)) values.set(p.time_order, new Map());
    values.get(p.time_order)!.set(p.entity, p.value);
    if (!entitySet.has(p.entity)) { entitySet.add(p.entity); entities.push(p.entity); }
    numericKeys.push(p.time_key);
  }

  const timeList = [...times.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([order, label]) => ({ order, label }));

  const numericTimes = timeList.length > 0 && timeList.every(t => Number.isFinite(Number(t.label)));

  return { times: timeList, values, entities, numericTimes };
}

/** 温和缓动：多步连播时平滑、单步内略有节奏（easeInOutSine） */
export function ease(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** time_order 总数 */
export function timeCount(ds: Dataset): number {
  return ds.times.length;
}

/**
 * 求任意（可为小数的）orderF 处的帧。
 * - k = floor(orderF)，t = orderF - k（eased）
 * - 并集 = A、B 两端各自 top maxBars 的实体集合（含"即将上榜"与"即将跌出"）
 * - 每实体 value = lerp(vA, vB, ease(t))，缺失端按 0 补位
 * - 当前帧排名 = 并集按当前值降序（并列按实体名字典序稳定）
 * - 绘制条数 = 前 maxBars 名
 */
export function interpolate(ds: Dataset, orderF: number, maxBars: number): InterpFrame {
  const N = ds.times.length;
  if (N === 0) return { timeLabel: '', timeLabelCont: null, bars: [] };
  if (N === 1) {
    const m = ds.values.get(ds.times[0].order)!;
    const bars = [...m.entries()]
      .map(([entity, value]) => ({ entity, value, rank: 0 }))
      .sort((a, b) => b.value - a.value || a.entity.localeCompare(b.entity, 'zh'))
      .slice(0, maxBars)
      .map((b, i) => ({ ...b, rank: i + 1 }));
    return { timeLabel: ds.times[0].label, timeLabelCont: null, bars };
  }

  const k = Math.min(Math.max(Math.floor(orderF), 0), N - 2);
  const t = Math.min(Math.max(orderF - k, 0), 1);
  const eased = ease(t);

  const mapA = ds.values.get(ds.times[k].order)!;
  const mapB = ds.values.get(ds.times[k + 1].order)!;

  const topOf = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .slice(0, maxBars)
      .map(([e]) => e);

  const union = new Set<string>([...topOf(mapA), ...topOf(mapB)]);

  const bars: BarState[] = [];
  for (const entity of union) {
    const vA = mapA.get(entity) ?? 0;
    const vB = mapB.get(entity) ?? 0;
    bars.push({ entity, value: lerp(vA, vB, eased), rank: 0 });
  }
  bars.sort((a, b) => b.value - a.value || a.entity.localeCompare(b.entity, 'zh'));
  const shown = bars.slice(0, maxBars);
  shown.forEach((b, i) => { b.rank = i + 1; });

  // 时间标签（方案 §6.2）：
  // timeLabel = 当前步标签（step 模式，过渡中点切换，兼顾观感与「切步时刷新」原则）
  // timeLabelCont = 数值插值保留一位小数（continuous 模式，仅数值时间点可用）
  let timeLabel: string;
  let timeLabelCont: string | null = null;
  if (ds.numericTimes) {
    const a = Number(ds.times[k].label);
    const b = Number(ds.times[k + 1].label);
    timeLabelCont = String(Math.round(lerp(a, b, t) * 10) / 10);
    timeLabel = t >= 0.5 ? ds.times[k + 1].label : ds.times[k].label;
  } else {
    timeLabel = t >= 0.5 ? ds.times[k + 1].label : ds.times[k].label;
  }
  return { timeLabel, timeLabelCont, bars: shown };
}

/** 总时长（秒）：headHold + (N-1)*secondsPerStep + tailHold（方案 §6.2） */
export function totalDuration(ds: Dataset, secondsPerStep: number, headHold: number, tailHold: number): number {
  const N = ds.times.length;
  if (N === 0) return 0;
  return headHold + Math.max(N - 1, 0) * secondsPerStep + tailHold;
}

/** 播放进度 p ∈ [0,1] → orderF */
export function progressToOrderF(ds: Dataset, p: number, secondsPerStep: number, headHold: number, tailHold: number): number {
  const N = ds.times.length;
  if (N === 0) return 0;
  const total = totalDuration(ds, secondsPerStep, headHold, tailHold);
  const elapsed = Math.min(Math.max(p, 0), 1) * total;
  const segStart = headHold;
  const segLen = Math.max(N - 1, 0) * secondsPerStep;
  if (elapsed <= segStart) return 0;
  if (elapsed >= segStart + segLen) return N - 1;
  return (elapsed - segStart) / secondsPerStep;
}
