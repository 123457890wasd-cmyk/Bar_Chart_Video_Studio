<template>
  <div ref="wrapEl" class="chart-wrap" :style="{ aspectRatio: `${config.width} / ${config.height}` }">
    <canvas ref="canvasEl"></canvas>
  </div>
</template>

<script setup lang="ts">
/**
 * 预览画布（方案 §2.3 / §6.3 预览循环）
 * 引擎为无 DOM 依赖的纯绘制函数；预览/导出共用同一 BarRaceRenderer。
 * 本组件只负责「把某个 orderF 处的帧画出来」，播放循环由外层驱动。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { RenderConfig } from '@barstudio/shared';
import { interpolate, progressToOrderF, type Dataset } from '../renderer/frames';
import { renderer } from '../renderer/engine';
import type { Palette } from '../renderer/palettes';

const props = defineProps<{
  dataset: Dataset;
  config: RenderConfig;
  palette: Palette;
  colorOf: (entity: string) => string;
}>();

const wrapEl = ref<HTMLDivElement>();
const canvasEl = ref<HTMLCanvasElement>();

let resizeObserver: ResizeObserver | null = null;

/** 预算的实体名标签区宽度（跨帧稳定，避免排名变化时布局抖动） */
const labelWidth = ref(0);

function paint(orderF: number) {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const frame = interpolate(props.dataset, orderF, props.config.maxBars);
  renderer.draw(frame, {
    width: canvas.width,
    height: canvas.height,
    config: props.config,
    palette: props.palette,
    colorOf: props.colorOf,
    labelWidth: labelWidth.value || undefined,
  }, ctx);
}

function resize() {
  const canvas = canvasEl.value;
  const wrap = wrapEl.value;
  if (!canvas || !wrap) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(wrap.clientWidth, 16);
  const h = Math.max(wrap.clientHeight, 9);
  const targetW = Math.round(w * dpr);
  const targetH = Math.round(h * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
    // 画布尺寸变了重算 label 预算
    recomputeLabelWidth();
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}

/** 按 dataset.entities 全集 + config.fontScale 预算最长实体名宽度（稳定） */
function recomputeLabelWidth() {
  const canvas = canvasEl.value;
  if (!canvas || !props.dataset || props.dataset.entities.length === 0) {
    labelWidth.value = 0;
    return;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const s = canvas.width / 1920;
  const fs = props.config.fontScale;
  const nameFont = `700 ${30 * s * fs}px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif`;
  const measured = renderer.measureLabelWidth(props.dataset.entities, nameFont, ctx);
  labelWidth.value = Math.min(460 * s, Math.max(120 * s, measured));
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    resize();
    paint(lastOrderF.value);
  });
  if (wrapEl.value) resizeObserver.observe(wrapEl.value);
  resize();
  recomputeLabelWidth();
  paint(0);
});

onBeforeUnmount(() => resizeObserver?.disconnect());

const lastOrderF = ref(0);

/** 命令式渲染接口 */
function renderAt(orderF: number) {
  lastOrderF.value = orderF;
  paint(orderF);
}

function renderProgress(p: number) {
  const orderF = progressToOrderF(
    props.dataset, p,
    props.config.secondsPerStep, props.config.headHold, props.config.tailHold,
  );
  renderAt(orderF);
}

watch(() => [props.config, props.dataset], () => {
  recomputeLabelWidth();
  paint(lastOrderF.value);
}, { deep: true });

defineExpose({ renderAt, renderProgress });
</script>

<style scoped>
.chart-wrap {
  width: 100%;
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: #fff;
}
.chart-wrap canvas { display: block; width: 100%; height: 100%; }
</style>
