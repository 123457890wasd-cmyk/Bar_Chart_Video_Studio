import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'projects', component: () => import('../pages/ProjectList.vue') },
    { path: '/projects/:id/data', name: 'data', component: () => import('../pages/DataManage.vue') },
    { path: '/projects/:id/edit', name: 'edit', component: () => import('../pages/Editor.vue') },
    { path: '/projects/:id/export', name: 'export', component: () => import('../pages/ExportPage.vue') },
  ],
});

export default router;
