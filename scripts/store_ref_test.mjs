#!/usr/bin/env node
/**
 * 前端 store 回归：draftConfig 引用稳定性
 *
 * 运行：node --import tsx scripts/store_ref_test.mjs
 *
 * 背景（真实 bug）：Editor.vue / ExportPage.vue 用 `const cfg = store.draftConfig`
 * 持有配置对象引用；一旦 store 内部出现 `draftConfig.value = {...}` 整体替换，
 * 消费方的引用会永久失联 —— 打开项目后配置面板显示默认值、编辑不回流到 store
 * （保存无效 / 预览不刷新 / dirty 恒 false / 离开不提示 / 导出用默认配置）。
 *
 * 本测试直接加载真实的 stores/project.ts（mock 后端 fetch），断言：
 *   1. loadProject 后，早先取到的 cfg 引用仍与 store.draftConfig 同一对象
 *   2. cfg 里的值等于项目已保存的配置
 *   3. 写 cfg 能回流到 store（双向绑定前提）
 */
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

// ---- mock 后端（返回一个 config 与默认值明显不同的项目）----
const PROJECT_CONFIG = { title: '项目里存的标题', maxBars: 20, width: 1280, height: 720 };
const json = (data) => new Response(JSON.stringify({ data }), {
  status: 200, headers: { 'content-type': 'application/json' },
});
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/datasets/summary')) {
    return json({ rowCount: 4, timeCount: 2, entityCount: 2, timeMin: '2024', timeMax: '2025', missingValues: 0, valueColumns: ['value'], activeValueColumn: 'value' });
  }
  if (u.includes('/datasets')) {
    return json({
      series: [
        { time_key: '2024', time_order: 0, entity: 'A', value: 10 },
        { time_key: '2024', time_order: 0, entity: 'B', value: 20 },
        { time_key: '2025', time_order: 1, entity: 'A', value: 15 },
        { time_key: '2025', time_order: 1, entity: 'B', value: 25 },
      ],
      valueColumns: ['value'], effectiveValueColumn: 'value',
    });
  }
  if (u.includes('/records')) return json([]);
  if (u.includes('/projects/1')) {
    return json({ id: 1, title: '我的项目', description: '', config: PROJECT_CONFIG, dataset_hash: 'h', hasData: true, created_at: '', updated_at: '' });
  }
  throw new Error('unexpected url ' + u);
};

setActivePinia(createPinia());
const { useProjectStore } = await import('../packages/frontend/src/stores/project.ts');
const store = useProjectStore();

// 模拟页面 setup：先取引用，再走 onMounted 的 loadProject
const cfg = store.draftConfig;
const sameBefore = cfg === store.draftConfig;
assert(sameBefore, '初始 cfg 与 store.draftConfig 同一对象');

await store.loadProject(1);

assert(cfg === store.draftConfig, 'loadProject 后引用不脱轨（对象被原地改写而非整体替换）',
  cfg === store.draftConfig ? '' : 'cfg 与 store.draftConfig 已不是同一对象');
assert(cfg.title === PROJECT_CONFIG.title,
  `cfg.title 反映项目已保存配置（期望「${PROJECT_CONFIG.title}」）`, `实际「${cfg.title}」`);
assert(cfg.maxBars === PROJECT_CONFIG.maxBars,
  `cfg.maxBars 反映项目已保存配置（期望 ${PROJECT_CONFIG.maxBars}）`, `实际 ${cfg.maxBars}`);

// 用户在编辑器里改配置（v-model 写 cfg）→ 必须回流到 store
cfg.title = '用户在编辑器手写的标题';
assert(store.draftConfig.title === '用户在编辑器手写的标题',
  '写 cfg 回流到 store.draftConfig（v-model 双向绑定前提）',
  `store 实际「${store.draftConfig.title}」`);

// dirty 由 deep watch 置位，Vue 的 watch 默认异步 flush → 等一个 tick
await nextTick();
assert(store.dirty === true, '编辑后 dirty=true（离开项目会提示未保存）', `dirty=${store.dirty}`);

console.log(`\nstore 引用稳定性：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
