<template>
  <div class="app-shell">
    <header class="app-header">
      <RouterLink to="/" class="brand">
        <span class="brand-mark">▊</span>
        <span class="brand-name">条形图竞赛工作室</span>
        <span class="brand-sub">Bar Chart Video Studio</span>
      </RouterLink>
      <nav class="app-nav" v-if="projectId">
        <RouterLink :to="`/projects/${projectId}/data`">数据</RouterLink>
        <RouterLink :to="`/projects/${projectId}/edit`">编辑器</RouterLink>
        <RouterLink :to="`/projects/${projectId}/export`">导出</RouterLink>
      </nav>
    </header>
    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const projectId = computed(() => (route.params.id ? Number(route.params.id) : null));
</script>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: 52px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  position: sticky;
  top: 0;
  z-index: 10;
}
.brand { display: flex; align-items: baseline; gap: 10px; text-decoration: none; color: var(--text); }
.brand-mark { color: var(--accent); font-weight: 800; font-size: 22px; }
.brand-name { font-weight: 700; font-size: 16px; }
.brand-sub { font-size: 12px; color: var(--sub); }
.app-nav { display: flex; gap: 4px; }
.app-nav a {
  padding: 6px 14px; border-radius: 8px; text-decoration: none;
  color: var(--sub); font-size: 14px; font-weight: 500;
}
.app-nav a.router-link-active { background: var(--accent-soft); color: var(--accent); }
.app-main { min-height: calc(100vh - 52px); }
</style>
