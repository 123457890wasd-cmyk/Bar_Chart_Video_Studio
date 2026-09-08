<template>
  <div class="page editor-page">
    <div class="page-head">
      <h1 class="page-title">{{ store.project?.title ?? '' }} · 编辑器</h1>
      <div class="head-actions">
        <RouterLink :to="`/projects/${projectId}/data`"><button>← 数据</button></RouterLink>
        <button class="primary" :disabled="!store.dirty || store.saving" @click="save">
          {{ store.saving ? '保存中…' : store.dirty ? '保存配置' : '已保存' }}
        </button>
        <RouterLink :to="`/projects/${projectId}/export`"><button class="primary">去导出 →</button></RouterLink>
      </div>
    </div>

    <div v-if="store.loading" class="empty">加载中…</div>
    <div v-else-if="!hasData" class="empty card">
      该项目还没有数据。<RouterLink :to="`/projects/${projectId}/data`">先去导入 →</RouterLink>
    </div>

    <div v-else class="editor-layout">
      <!-- 左侧配置面板 -->
      <aside class="config-panel card">
        <h3>画面配置</h3>

        <label class="field"><span>主标题</span>
          <input v-model="cfg.title" type="text" /></label>
        <label class="field"><span>副标题</span>
          <input v-model="cfg.subtitle" type="text" placeholder="可选" /></label>
        <label class="field"><span>来源角标（左下角）</span>
          <input v-model="cfg.sourceNote" type="text" /></label>

        <!--
          ▶ 横坐标值列选取：仅当数据集携带多个值列（如 原始 / 插值 / 填补）
          才显示此选择器。单值数据集显示占位提示，用户也可以去数据页重新导入。
        -->
        <label class="field" v-if="hasValueColumnChoice">
          <span>横坐标（柱长）使用的数据列</span>
          <select v-model="valueColumnChoice" @change="onValueColumnChange">
            <option v-for="c in store.valueColumns" :key="c" :value="c">{{ c }}</option>
          </select>
          <span class="hint">切换后立即生效，便于对比同一数据集不同处理方式</span>
        </label>
        <div v-else class="hint-box">
          当前为单值数据集（仅 1 个值列）。如需横坐标多列对比，请到「数据」页用长表多值列重新导入。
        </div>

        <!-- ▶ 显示条形数（maxBars）：直观滑块 1..50 -->
        <div class="field slider-field">
          <span>显示条形数（top N） · <b>{{ cfg.maxBars }}</b></span>
          <input
            v-model.number="cfg.maxBars"
            type="range"
            :min="1"
            :max="50"
            step="1"
          />
          <span class="hint">
            共 {{ store.dataset.entities.length }} 个实体参与排名，只显示前 N 名。
            调到 50 即全显示。
          </span>
        </div>

        <div class="row2">
          <label class="field"><span>每段时间（秒）</span>
            <input v-model.number="cfg.secondsPerStep" type="number" min="0.1" max="10" step="0.1" /></label>
          <label class="field"><span>片头定格（秒）</span>
            <input v-model.number="cfg.headHold" type="number" min="0" max="5" step="0.1" /></label>
        </div>
        <label class="field"><span>片尾定格（秒）</span>
          <input v-model.number="cfg.tailHold" type="number" min="0" max="5" step="0.1" /></label>

        <label class="field"><span>配色方案</span>
          <select v-model="cfg.palette">
            <option v-for="p in PALETTES" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>

        <div class="row2">
          <label class="field"><span>数值小数位</span>
            <select v-model.number="cfg.valueDecimals">
              <option :value="0">0 位（1,234）</option>
              <option :value="1">1 位（1,234.5）</option>
              <option :value="2">2 位（1,234.56）</option>
            </select>
          </label>
          <label class="field"><span>字号档</span>
            <select v-model.number="cfg.fontScale">
              <option :value="0.85">小</option>
              <option :value="1">标准</option>
              <option :value="1.2">大</option>
            </select>
          </label>
        </div>

        <div class="row2">
          <label class="field"><span>时间标签位置</span>
            <select v-model="cfg.timeLabelPos">
              <option value="top-left">左上</option>
              <option value="top-right">右上</option>
              <option value="none">不显示</option>
            </select>
          </label>
          <label class="field"><span>时间标签模式</span>
            <select v-model="cfg.timeLabelMode" :disabled="!store.dataset.numericTimes">
              <option value="step">按步切换</option>
              <option value="continuous">连续插值</option>
            </select>
          </label>
        </div>

        <div class="check-row">
          <label><input v-model="cfg.showValues" type="checkbox" /> 显示条形数值</label>
          <label><input v-model="cfg.showRank" type="checkbox" /> 显示排名序号</label>
        </div>

        <label class="field"><span>背景色</span>
          <input v-model="cfg.background" type="color" style="height: 36px; padding: 2px" />
        </label>

        <div class="duration-info">
          预计成片时长：<b>{{ totalDur.toFixed(1) }}s</b>
          （{{ store.dataset.times.length }} 个时间点 × {{ cfg.secondsPerStep }}s + 头尾定格）
        </div>
      </aside>

      <!-- 右侧预览 -->
      <section class="preview-area">
        <BarChartCanvas
          ref="canvasRef"
          :dataset="store.dataset"
          :config="cfg"
          :palette="store.palette"
          :color-of="store.colorOf"
        />
        <TimelineControls
          :playing="playing"
          :progress="progress"
          :speed="speed"
          :time-label="timeLabel"
          @toggle="togglePlay"
          @seek="onSeek"
          @speed="(v) => (speed = v)"
          @step="stepTime"
        />
        <div class="preview-tip">
          预览分辨率随窗口自适应；导出时按配置分辨率（{{ cfg.width }}×{{ cfg.height }}@{{ cfg.fps }}fps）在隐藏画布重绘录制。
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useProjectStore } from '../stores/project';
import BarChartCanvas from '../components/BarChartCanvas.vue';
import TimelineControls from '../components/TimelineControls.vue';
import { progressToOrderF, totalDuration } from '../renderer/frames';
import { PALETTES } from '../renderer/palettes';

const route = useRoute();
const projectId = computed(() => Number(route.params.id));
const store = useProjectStore();

const hasData = computed(() => (store.summary?.rowCount ?? 0) > 0);
const cfg = store.draftConfig; // 草稿：即改即生效，保存才落库

const hasValueColumnChoice = computed(() =>
  store.valueColumns.length > 1 || (store.valueColumns.length === 1 && store.valueColumns[0] !== 'value')
);
const valueColumnChoice = ref(cfg.valueColumn ?? store.activeValueColumn);
watch(() => cfg.valueColumn, v => { valueColumnChoice.value = v ?? 'value'; }, { immediate: true });

async function onValueColumnChange() {
  if (valueColumnChoice.value && valueColumnChoice.value !== cfg.valueColumn) {
    await store.switchValueColumn(valueColumnChoice.value);
  }
}

const canvasRef = ref<InstanceType<typeof BarChartCanvas>>();
const playing = ref(false);
const progress = ref(0);
const speed = ref(1);

const totalDur = computed(() =>
  totalDuration(store.dataset, cfg.secondsPerStep, cfg.headHold, cfg.tailHold)
);

const timeLabel = computed(() => {
  const times = store.dataset.times;
  if (times.length === 0) return '—';
  const orderF = progressToOrderF(store.dataset, progress.value, cfg.secondsPerStep, cfg.headHold, cfg.tailHold);
  const idx = Math.min(Math.max(Math.round(orderF), 0), times.length - 1);
  return times[idx].label;
});

let rafId = 0;
let lastTs = 0;

function loop(ts: number) {
  if (!playing.value) return;
  const dt = lastTs ? (ts - lastTs) / 1000 : 0;
  lastTs = ts;
  if (totalDur.value > 0) {
    progress.value += (dt * speed.value) / totalDur.value;
    if (progress.value >= 1) {
      progress.value = 1;
      playing.value = false;
    }
  }
  renderCurrent();
  if (playing.value) rafId = requestAnimationFrame(loop);
}

function renderCurrent() {
  const orderF = progressToOrderF(store.dataset, progress.value, cfg.secondsPerStep, cfg.headHold, cfg.tailHold);
  canvasRef.value?.renderAt(orderF);
}

function togglePlay() {
  if (progress.value >= 1) progress.value = 0;
  playing.value = !playing.value;
  if (playing.value) {
    lastTs = 0;
    rafId = requestAnimationFrame(loop);
  }
}

function onSeek(p: number) {
  progress.value = Math.min(Math.max(p, 0), 1);
  playing.value = false;
  renderCurrent();
}

function stepTime(dir: 1 | -1) {
  playing.value = false;
  const orderF = progressToOrderF(store.dataset, progress.value, cfg.secondsPerStep, cfg.headHold, cfg.tailHold);
  const k = Math.round(orderF);
  const next = Math.min(Math.max(k + dir, 0), store.dataset.times.length - 1);
  const seg = (cfg.headHold + next * cfg.secondsPerStep) / Math.max(totalDur.value, 0.001);
  progress.value = Math.min(Math.max(seg, 0), 1);
  renderCurrent();
}

// 配置变化时重绘当前帧
watch(() => [cfg.secondsPerStep, cfg.headHold, cfg.tailHold, cfg.maxBars], () => renderCurrent());
watch(() => store.dataset, () => renderCurrent());

async function save() {
  await store.saveConfig();
}

onMounted(async () => {
  await store.loadProject(projectId.value);
  valueColumnChoice.value = cfg.valueColumn ?? store.activeValueColumn ?? 'value';
  renderCurrent();
});

onBeforeUnmount(() => {
  playing.value = false;
  cancelAnimationFrame(rafId);
});
</script>

<style scoped>
.editor-page { max-width: 1440px; }
.page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.page-head .page-title { margin: 0; }
.head-actions { display: flex; gap: 8px; align-items: center; }

.editor-layout { display: grid; grid-template-columns: 320px 1fr; gap: 16px; align-items: start; }
.config-panel { position: sticky; top: 68px; max-height: calc(100vh - 90px); overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.config-panel h3 { margin: 0 0 4px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.check-row { display: flex; gap: 16px; font-size: 13px; color: var(--text); }
.check-row label { display: flex; align-items: center; gap: 6px; }
.field.slider-field { display: flex; flex-direction: column; gap: 4px; }
.field.slider-field input[type=range] { width: 100%; }
.field .hint,
.slider-field .hint {
  font-size: 11px;
  color: var(--sub);
  line-height: 1.5;
}
.hint-box {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--sub);
  background: var(--bg);
  border-radius: 6px;
  line-height: 1.55;
}
.duration-info {
  margin-top: 8px; font-size: 13px; color: var(--sub);
  background: var(--bg); padding: 10px 12px; border-radius: 8px; line-height: 1.6;
}
.preview-area { display: flex; flex-direction: column; }
.preview-tip { font-size: 12px; color: var(--sub); margin-top: 10px; }
</style>
