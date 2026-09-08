<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">{{ store.project?.title ?? '' }} · 数据</h1>
      <div class="head-actions">
        <RouterLink v-if="hasData" :to="`/projects/${projectId}/edit`">
          <button class="primary">进入编辑器 →</button>
        </RouterLink>
      </div>
    </div>

    <!-- 数据摘要 -->
    <div v-if="store.loading" class="empty">加载中…</div>
    <template v-else>
      <div v-if="hasData" class="card summary-card">
        <div class="sum-item"><b>{{ store.summary?.rowCount ?? 0 }}</b><span>数据行</span></div>
        <div class="sum-item"><b>{{ store.summary?.timeCount ?? 0 }}</b><span>时间点</span></div>
        <div class="sum-item"><b>{{ store.summary?.entityCount ?? 0 }}</b><span>实体</span></div>
        <div class="sum-item"><b>{{ store.summary?.timeMin ?? '—' }} ~ {{ store.summary?.timeMax ?? '—' }}</b><span>时间范围</span></div>
        <div class="sum-spacer"></div>
        <button @click="reimportOpen = !reimportOpen">{{ reimportOpen ? '收起导入' : '重新导入' }}</button>
        <button class="danger" @click="clearAll">清空数据</button>
      </div>

      <!-- 导入区 -->
      <div v-if="!hasData || reimportOpen" class="card import-card">
        <h3>导入数据</h3>
        <p class="import-hint">
          支持 <b>CSV / Excel(.xlsx) / JSON 长表</b> 文件、粘贴表格（Excel 直接 Ctrl+C/V），或从政府公开数据源填入文件 URL。
          标准形状：每行 = <code>时间 × 实体 × 数值</code>；宽表（行=年份、列=省份）也能自动转换。
        </p>

        <div class="import-tabs">
          <button :class="{ active: tab === 'file' }" @click="tab = 'file'">上传文件</button>
          <button :class="{ active: tab === 'paste' }" @click="tab = 'paste'">粘贴表格</button>
          <button :class="{ active: tab === 'url' }" @click="tab = 'url'">数据源 URL</button>
        </div>

        <!-- 文件上传 -->
        <div v-if="tab === 'file'" class="dropzone" @dragover.prevent @drop.prevent="onDrop">
          <input ref="fileInput" type="file" accept=".csv,.xlsx,.xls,.json,text/csv" hidden @change="onFileChange" />
          <div class="dz-icon">📄</div>
          <div>拖拽文件到此处，或 <a @click.prevent="fileInput?.click()">点击选择</a></div>
          <div class="dz-sub">.csv（含 GBK 编码自动识别）/ .xlsx / .json</div>
        </div>

        <!-- 粘贴 -->
        <div v-else-if="tab === 'paste'" class="paste-box">
          <textarea
            v-model="pasteText"
            rows="8"
            placeholder="在 Excel 中选中区域复制，然后粘贴到这里（支持 TSV / CSV 文本）"
          ></textarea>
          <button style="margin-top: 10px" :disabled="!pasteText.trim()" @click="parsePaste">解析粘贴内容</button>
        </div>

        <!-- URL 抓取 -->
        <div v-else class="url-box">
          <label class="field">
            <span>CSV 文件直链 URL（政府公开数据等）</span>
            <input v-model="sourceUrl" type="text" placeholder="https://…/data.csv" />
          </label>
          <button style="margin-top: 10px" :disabled="!sourceUrl.trim() || importing" @click="importFromUrl">
            {{ importing ? '抓取中…' : '抓取并导入' }}
          </button>
          <div class="ds-list">
            <div class="ds-title">常用政府公开统计入口（备忘）：</div>
            <a v-for="ds in datasources" :key="ds.id" class="ds-item" :href="ds.url" target="_blank" rel="noopener">
              <b>{{ ds.name }}</b><span>{{ ds.note }}</span>
            </a>
          </div>
        </div>

        <!-- 解析结果：模式 + 映射 + 校验报告 -->
        <div v-if="parsed" class="parse-result">
          <h4>① 确认表格结构</h4>
          <div class="mode-row">
            <label class="mode-opt">
              <input v-model="mode" type="radio" value="long" />
              <span>长表：每行 = 时间/实体/数值 三列</span>
            </label>
            <label class="mode-opt">
              <input v-model="mode" type="radio" value="wide-by-row" />
              <span>宽表（行=时间，列=实体）</span>
            </label>
            <label class="mode-opt">
              <input v-model="mode" type="radio" value="wide-by-col" />
              <span>宽表（行=实体，列=时间）</span>
            </label>
          </div>

          <template v-if="mode === 'long'">
            <h4>② 选择列映射</h4>
            <div class="map-row">
              <label class="field"><span>时间列</span>
                <select v-model="mapping.time"><option v-for="f in parsed.fields" :key="f" :value="f">{{ f }}</option></select>
              </label>
              <label class="field"><span>实体列</span>
                <select v-model="mapping.entity"><option v-for="f in parsed.fields" :key="f" :value="f">{{ f }}</option></select>
              </label>
              <label class="field"><span>数值列</span>
                <select v-model="mapping.value"><option v-for="f in parsed.fields" :key="f" :value="f">{{ f }}</option></select>
              </label>
            </div>
          </template>

          <h4>{{ mode === 'long' ? '③' : '②' }} 原始数据预览（前 8 行）</h4>
          <div class="preview-scroll">
            <table class="grid">
              <thead><tr><th v-for="f in parsed.fields" :key="f">{{ f }}</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in parsed.rows.slice(0, 8)" :key="i">
                  <td v-for="(c, j) in r" :key="j">{{ c }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 转换结果 + 校验报告 -->
          <h4>{{ mode === 'long' ? '④' : '③' }} 转换与校验</h4>
          <div v-if="convertErrors.length" class="report err">
            <div v-for="e in convertErrors" :key="e">✗ {{ e }}</div>
          </div>
          <div v-if="convertWarnings.length" class="report warn">
            <div v-for="w in convertWarnings" :key="w">⚠ {{ w }}</div>
          </div>
          <div class="convert-info" v-if="longRows.length">
            转换得到 <b>{{ longRows.length }}</b> 行长表 ·
            <b>{{ new Set(longRows.map(r => r.entity)).size }}</b> 个实体 ·
            <b>{{ new Set(longRows.map(r => r.time_key)).size }}</b> 个时间点
          </div>

          <div class="import-actions">
            <button class="ghost" @click="resetParse">取消</button>
            <button class="primary" :disabled="longRows.length === 0 || importing" @click="submitImport">
              {{ importing ? '导入中…' : hasData ? '全量替换导入' : '确认导入' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 已有数据预览 -->
      <div v-if="hasData" class="card">
        <h3>数据预览 <span class="tag">{{ store.series.length }} 行 · 显示前 {{ previewLimit }} 行</span></h3>
        <div class="preview-scroll">
          <table class="grid">
            <thead><tr><th style="width: 80px">排序</th><th>时间</th><th>实体</th><th style="text-align: right">数值</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in store.series.slice(0, previewLimit)" :key="i">
                <td>{{ r.time_order }}</td><td>{{ r.time_key }}</td><td>{{ r.entity }}</td>
                <td style="text-align: right">{{ r.value.toLocaleString('zh-CN') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { DatasourceInfo } from '@barstudio/shared';
import { api } from '../api/client';
import { useProjectStore } from '../stores/project';
import {
  guessMapping, parseDelimitedText, parseFile, toLongRows,
  type ColumnMapping, type ParsedTable, type TableMode,
} from '../importer/parse';

const route = useRoute();
const projectId = computed(() => Number(route.params.id));
const store = useProjectStore();

const hasData = computed(() => (store.summary?.rowCount ?? 0) > 0);
const reimportOpen = ref(false);
const previewLimit = 100;

const tab = ref<'file' | 'paste' | 'url'>('file');
const fileInput = ref<HTMLInputElement>();
const pasteText = ref('');
const sourceUrl = ref('');
const importing = ref(false);

const parsed = ref<ParsedTable | null>(null);
const mode = ref<TableMode>('long');
const mapping = ref<ColumnMapping>({ time: '', entity: '', value: '' });

const datasources = ref<DatasourceInfo[]>([]);

const convertResult = computed(() =>
  parsed.value ? toLongRows(parsed.value, mode.value, mapping.value) : { rows: [], errors: [], warnings: [] }
);
const longRows = computed(() => convertResult.value.rows);
const convertErrors = computed(() => convertResult.value.errors);
const convertWarnings = computed(() => convertResult.value.warnings);

async function handleTable(t: ParsedTable) {
  parsed.value = t;
  const guess = guessMapping(t);
  if (guess) {
    mode.value = 'long';
    mapping.value = { ...guess };
  } else {
    mode.value = 'wide-by-row';
  }
  reimportOpen.value = true;
}

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    await handleTable(await parseFile(file));
  } catch (err: any) {
    alert(`解析失败：${err.message}`);
  }
}

async function onDrop(e: DragEvent) {
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    await handleTable(await parseFile(file));
  } catch (err: any) {
    alert(`解析失败：${err.message}`);
  }
}

function parsePaste() {
  try {
    handleTable(parseDelimitedText(pasteText.value));
  } catch (err: any) {
    alert(`解析失败：${err.message}`);
  }
}

async function importFromUrl() {
  importing.value = true;
  try {
    await api.post(`/projects/${projectId.value}/datasets/upload`, { sourceUrl: sourceUrl.value.trim() });
    await store.loadProject(projectId.value);
    reimportOpen.value = false;
    parsed.value = null;
  } catch (err: any) {
    alert(`导入失败：${err.message}`);
  } finally {
    importing.value = false;
  }
}

async function submitImport() {
  importing.value = true;
  try {
    await store.importRows(longRows.value);
    reimportOpen.value = false;
    parsed.value = null;
  } catch (err: any) {
    alert(`导入失败：${err.message}`);
  } finally {
    importing.value = false;
  }
}

function resetParse() {
  parsed.value = null;
  pasteText.value = '';
  if (fileInput.value) fileInput.value.value = '';
}

async function clearAll() {
  if (!confirm('确定清空该项目的全部数据？此操作不可恢复。')) return;
  await store.clearData();
}

watch(mode, () => { /* 模式切换时重新计算由 computed 完成 */ });

onMounted(async () => {
  await store.loadProject(projectId.value);
  try {
    datasources.value = await api.get<DatasourceInfo[]>('/datasources');
  } catch { /* 备忘列表失败不阻塞 */ }
});
</script>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.page-head .page-title { margin: 0; }
.summary-card { display: flex; align-items: center; gap: 28px; margin-bottom: 16px; flex-wrap: wrap; }
.sum-item { display: flex; flex-direction: column; }
.sum-item b { font-size: 18px; }
.sum-item span { font-size: 12px; color: var(--sub); }
.sum-spacer { flex: 1; }

.import-card h3 { margin: 0 0 8px; }
.import-hint { color: var(--sub); font-size: 13px; line-height: 1.7; margin: 0 0 14px; }
.import-hint code { background: var(--bg); padding: 1px 6px; border-radius: 4px; }
.import-tabs { display: flex; gap: 6px; margin-bottom: 14px; }
.import-tabs button.active { background: var(--accent); color: #fff; border-color: var(--accent); }

.dropzone {
  border: 2px dashed var(--border); border-radius: 12px; padding: 34px;
  text-align: center; color: var(--sub); background: var(--bg);
}
.dropzone a { color: var(--accent); cursor: pointer; text-decoration: underline; }
.dz-icon { font-size: 30px; margin-bottom: 8px; }
.dz-sub { font-size: 12px; margin-top: 6px; }

.paste-box textarea { font-family: 'Roboto Mono', monospace; font-size: 12px; }
.url-box .ds-list { margin-top: 18px; }
.ds-title { font-size: 13px; color: var(--sub); margin-bottom: 8px; }
.ds-item { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; text-decoration: none; color: var(--text); font-size: 13px; }
.ds-item:hover { border-color: var(--accent); }
.ds-item span { color: var(--sub); font-size: 12px; }

.parse-result { border-top: 1px solid var(--border); margin-top: 18px; padding-top: 16px; }
.parse-result h4 { margin: 14px 0 8px; font-size: 13px; color: var(--sub); }
.mode-row { display: flex; gap: 18px; flex-wrap: wrap; }
.mode-opt { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.map-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.preview-scroll { max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }

.report { border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 8px; max-height: 140px; overflow: auto; }
.report.err { background: #fef2f2; color: var(--danger); }
.report.warn { background: #fffbeb; color: var(--warn); }
.convert-info { font-size: 13px; color: var(--sub); margin: 8px 0; }
.import-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }

.card h3 { margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
</style>
