/**
 * BarRaceRenderer —— Canvas 2D 渲染内核（技术方案 §3.3）
 *
 * 引擎形态：与 Vue 无关的纯绘制模块。
 * 输入：InterpFrame + DrawOptions；输出：一帧画面到任意 CanvasRenderingContext2D。
 * 「预览画布」与「录制画布」共用同一引擎，仅尺寸参数不同（方案 §2.3）。
 *
 * 绘制顺序（每帧）：清背景 → 网格/轴线 → 条形（圆角矩形、实体标签、末端数值）
 *                → 标题/角标 → 时间大标签（半透明大字，压在条形区一角）
 */
import type { RenderConfig } from '@barstudio/shared';
import type { InterpFrame } from './frames';
import type { Palette } from './palettes';

export interface DrawOptions {
  width: number;
  height: number;
  config: RenderConfig;
  palette: Palette;
  colorOf: (entity: string) => string;
}

const FONT_STACK = '"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';
const NUM_FONT_STACK = '"DIN Alternate","Bahnschrift","Roboto Mono",ui-monospace,monospace';

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function formatNumber(v: number, decimals: number): string {
  return v.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export class BarRaceRenderer {
  /** 预测量实体标签区宽度（避免每帧宽度跳动）；在数据/字号变化时调用 */
  measureLabelWidth(entities: string[], sampleFont: string, ctx: CanvasRenderingContext2D): number {
    ctx.font = sampleFont;
    let w = 0;
    for (const e of entities) w = Math.max(w, ctx.measureText(e).width);
    return w;
  }

  draw(frame: InterpFrame, opts: DrawOptions, ctx: CanvasRenderingContext2D): void {
    const { width: W, height: H, config, palette, colorOf } = opts;
    const s = W / 1920; // 等比缩放基准：以宽度为基准（横竖屏通吃）
    const fs = config.fontScale;

    // ---- 背景 ----
    ctx.fillStyle = config.background || palette.background;
    ctx.fillRect(0, 0, W, H);

    // ---- 版面度量（1080p 基准 × s）----
    const padX = 56 * s;
    const titleH = (config.title ? 60 : 0) * s * fs + (config.subtitle ? 40 : 0) * s * fs;
    const plotTop = 64 * s + titleH + 30 * s;
    const plotBottom = H - (config.sourceNote ? 64 : 40) * s;
    const plotH = Math.max(plotBottom - plotTop, 10 * s);

    // 实体标签区宽度：按最长实体名测量（稳定，不随帧变化）
    const nameFont = `${700} ${30 * s * fs}px ${FONT_STACK}`;
    const maxNameW = Math.min(
      460 * s,
      Math.max(120 * s, this.measureLabelWidth(frame.bars.map(b => b.entity), nameFont, ctx))
    );
    const rankW = config.showRank ? 72 * s : 0;
    const plotLeft = padX + rankW + maxNameW + 24 * s;
    const valueSpace = config.showValues ? 190 * s : 40 * s;
    const plotW = Math.max(W - plotLeft - padX - valueSpace, 40 * s);

    const maxBars = frame.bars.length;
    const rowH = plotH / Math.max(maxBars, 1);
    const barH = Math.min(rowH * 0.72, 90 * s);
    const x0 = plotLeft;
    const x1 = plotLeft + plotW;

    // ---- 比例尺：当前帧最大值 × 1.05（bar race 惯例：头名恒接近满宽）----
    let maxVal = 0;
    for (const b of frame.bars) maxVal = Math.max(maxVal, b.value);
    const scaleMax = maxVal > 0 ? maxVal * 1.05 : 1;
    const xOf = (v: number) => x0 + (Math.max(v, 0) / scaleMax) * plotW;

    // ---- 网格 + 轴刻度 ----
    const gridFont = `500 ${24 * s * fs}px ${NUM_FONT_STACK}`;
    ctx.font = gridFont;
    ctx.fillStyle = palette.subText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const v = (scaleMax / ticks) * i;
      const x = xOf(v);
      ctx.strokeStyle = palette.grid;
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      if (i > 0) {
        ctx.fillText(formatNumber(v, config.valueDecimals), x, plotTop - 14 * s);
      }
    }
    // x 轴基线
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.moveTo(x0, plotTop);
    ctx.lineTo(x0, plotBottom);
    ctx.stroke();

    // ---- 条形（从第 1 名到第 maxBars 名）----
    frame.bars.forEach((b, i) => {
      const cy = plotTop + rowH * i + rowH / 2;
      const y = cy - barH / 2;
      const w = Math.max(xOf(b.value) - x0, 2 * s);
      const color = colorOf(b.entity);

      // 排名序号
      if (config.showRank) {
        ctx.font = `700 ${26 * s * fs}px ${NUM_FONT_STACK}`;
        ctx.fillStyle = palette.subText;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(b.rank), x0 - maxNameW - 34 * s, cy);
      }

      // 实体名（条左侧，右对齐）
      ctx.font = nameFont;
      ctx.fillStyle = palette.text;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.entity, x0 - 24 * s, cy);

      // 圆角条形
      ctx.fillStyle = color;
      roundRectPath(ctx, x0, y, w, barH, barH / 2);
      ctx.fill();

      // 数值文本
      if (config.showValues) {
        const text = formatNumber(b.value, config.valueDecimals);
        ctx.font = `700 ${30 * s * fs}px ${NUM_FONT_STACK}`;
        const tw = ctx.measureText(text).width;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        if (x0 + w + 14 * s + tw <= W - padX) {
          // 末端右侧
          ctx.fillStyle = palette.text;
          ctx.fillText(text, x0 + w + 14 * s, cy);
        } else {
          // 放不下时画在条内右端
          ctx.fillStyle = palette.onBar;
          ctx.textAlign = 'right';
          ctx.fillText(text, x0 + w - 18 * s, cy);
        }
      }
    });

    // ---- 标题 / 副标题 ----
    if (config.title) {
      ctx.font = `700 ${52 * s * fs}px ${FONT_STACK}`;
      ctx.fillStyle = palette.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(config.title, W / 2, 84 * s * fs + 8 * s);
    }
    if (config.subtitle) {
      ctx.font = `400 ${28 * s * fs}px ${FONT_STACK}`;
      ctx.fillStyle = palette.subText;
      ctx.textAlign = 'center';
      ctx.fillText(config.subtitle, W / 2, 128 * s * fs + 10 * s);
    }

    // ---- 来源角标（左下）----
    if (config.sourceNote) {
      ctx.font = `400 ${22 * s * fs}px ${FONT_STACK}`;
      ctx.fillStyle = palette.subText;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(config.sourceNote, padX, H - 28 * s);
    }

    // ---- 时间大标签（半透明、大字，压在条形区上方一角）----
    const timeText =
      config.timeLabelMode === 'continuous' && frame.timeLabelCont != null
        ? frame.timeLabelCont
        : frame.timeLabel;
    if (config.timeLabelPos !== 'none' && timeText) {
      ctx.font = `700 ${210 * s * fs}px ${NUM_FONT_STACK}`;
      ctx.fillStyle = palette.timeLabel;
      ctx.textBaseline = 'alphabetic';
      if (config.timeLabelPos === 'top-right') {
        ctx.textAlign = 'right';
        ctx.fillText(timeText, W - padX - 40 * s, plotTop + 190 * s * fs);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(timeText, padX + 24 * s, plotTop + 190 * s * fs);
      }
    }
  }
}

export const renderer = new BarRaceRenderer();
