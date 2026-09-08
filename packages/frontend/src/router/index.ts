import { createRouter, createWebHistory } from 'vue-router';
import { useProjectStore } from '../stores/project';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'projects', component: () => import('../pages/ProjectList.vue') },
    { path: '/projects/:id/data', name: 'data', component: () => import('../pages/DataManage.vue') },
    { path: '/projects/:id/edit', name: 'edit', component: () => import('../pages/Editor.vue') },
    { path: '/projects/:id/export', name: 'export', component: () => import('../pages/ExportPage.vue') },
  ],
});

/**
 * 全局路由守门员：离开「项目内页面」前，若 draftConfig 是 dirty，弹 confirm。
 * 也负责清空 store（在确认离开或直接离开时）。
 *
 * 触发 closeProject 的三种情况：
 * 1) 进入另一个不同 id 的项目页：旧项目关闭、新项目打开（由各页 onMounted 自己 loadProject）
 * 2) 回到项目列表（/）
 * 3) 浏览器关窗：beforeunload，不经过这里
 */
router.beforeEach(async (to, from) => {
  // 仅在「跨项目 + 离开项目」这两类变化时考虑 dirty / 关项目
  const fromProjectId = from.params.id ? Number(from.params.id) : null;
  const toProjectId = to.params.id ? Number(to.params.id) : null;

  // 同项目内 tab 切（数据 ↔ 编辑器 ↔ 导出）—— 不关项目、不问 dirty
  if (fromProjectId !== null && fromProjectId === toProjectId) return true;

  // 跨项目跳转（从项目 A 出去 → 项目 B 进入）：关 A、开 B
  if (fromProjectId !== null && toProjectId !== null && fromProjectId !== toProjectId) {
    const store = useProjectStore();
    if (store.dirty) {
      const ok = window.confirm(
        `当前项目（#${fromProjectId}）有未保存的配置改动，确定放弃吗？`,
      );
      if (!ok) return false;
    }
    store.closeProject(); // 各目标页 onMounted 自己 loadProject
    return true;
  }

  // 离开项目回到列表
  if (fromProjectId !== null && toProjectId === null && to.path === '/') {
    const store = useProjectStore();
    if (store.dirty) {
      const ok = window.confirm(
        '当前项目有未保存的配置改动。\n确定放弃并返回项目列表吗？',
      );
      if (!ok) return false;
    }
    store.closeProject();
    return true;
  }

  return true;
});

export default router;
