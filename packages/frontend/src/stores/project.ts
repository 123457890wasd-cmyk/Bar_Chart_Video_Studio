/**
 * Pinia 项目 store：当前项目 / 时序数据 / 渲染配置草稿
 * 配置即改即生效（草稿暂存，「保存」才落库——方案 §3.2）
 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { DatasetSummary, ProjectInfo, RenderConfig, RecordInfo, SeriesPoint } from '@barstudio/shared';
import { DEFAULT_RENDER_CONFIG } from '@barstudio/shared';
import { api } from '../api/client';
import { buildDataset, type Dataset } from '../renderer/frames';
import { getPalette, makeColorOf, type Palette } from '../renderer/palettes';

export const useProjectStore = defineStore('project', () => {
  const project = ref<ProjectInfo | null>(null);
  const series = ref<SeriesPoint[]>([]);
  const summary = ref<DatasetSummary | null>(null);
  const records = ref<RecordInfo[]>([]);
  const loading = ref(false);
  const saving = ref(false);

  /** 渲染配置草稿（编辑器实时改，保存才写库） */
  const draftConfig = ref<RenderConfig>({ ...DEFAULT_RENDER_CONFIG });
  const dirty = ref(false);

  const dataset = computed<Dataset>(() => buildDataset(series.value));
  const palette = computed<Palette>(() => getPalette(draftConfig.value.palette));
  const colorOf = computed(() => makeColorOf(dataset.value.entities, palette.value));

  watch(draftConfig, () => { dirty.value = true; }, { deep: true });

  async function loadProject(id: number) {
    loading.value = true;
    try {
      project.value = await api.get<ProjectInfo>(`/projects/${id}`);
      draftConfig.value = { ...DEFAULT_RENDER_CONFIG, ...project.value.config };
      dirty.value = false;
      await Promise.all([loadSeries(), loadRecords()]);
    } finally {
      loading.value = false;
    }
  }

  async function loadSeries() {
    if (!project.value) return;
    series.value = await api.get<SeriesPoint[]>(`/projects/${project.value.id}/datasets`);
    summary.value = await api.get<DatasetSummary>(`/projects/${project.value.id}/datasets/summary`);
  }

  async function loadRecords() {
    records.value = await api.get<RecordInfo[]>(`/records?projectId=${project.value?.id ?? ''}`);
  }

  async function importRows(rows: { time_key: string; entity: string; value: number }[]) {
    if (!project.value) return;
    await api.post(`/projects/${project.value.id}/datasets/import`, { rows });
    // 只刷新数据相关字段，保留 draftConfig（用户的未保存草稿不应被 DB 内容覆盖）
    await loadSeries();
    // 重新同步 project 元数据（dataset_hash/updated_at 等），但不重置 draftConfig
    const fresh = await api.get<ProjectInfo>(`/projects/${project.value.id}`);
    project.value = { ...project.value, dataset_hash: fresh.dataset_hash, updated_at: fresh.updated_at, hasData: fresh.hasData };
  }

  async function saveConfig() {
    if (!project.value) return;
    saving.value = true;
    try {
      project.value = await api.patch<ProjectInfo>(`/projects/${project.value.id}`, {
        title: project.value.title,
        config: draftConfig.value,
      });
      dirty.value = false;
    } finally {
      saving.value = false;
    }
  }

  async function clearData() {
    if (!project.value) return;
    await api.del(`/projects/${project.value.id}/datasets`);
    // 局部刷新：避免覆盖用户当前未保存的 draftConfig 草稿
    await loadSeries();
    const fresh = await api.get<ProjectInfo>(`/projects/${project.value.id}`);
    project.value = { ...project.value, dataset_hash: fresh.dataset_hash, updated_at: fresh.updated_at, hasData: fresh.hasData };
  }

  return {
    project, series, summary, records, loading, saving,
    draftConfig, dirty, dataset, palette, colorOf,
    loadProject, loadSeries, loadRecords, importRows, saveConfig, clearData,
  };
});
