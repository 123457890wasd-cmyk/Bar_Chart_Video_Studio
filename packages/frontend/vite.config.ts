import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 读后端实际端口（pick-port.mjs 预选，backend 启动后也会写回）。
 * Windows 的动态端口排除区间会随重启漂移，代理目标不能写死。
 */
function backendPort(): number {
  try {
    const portFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../backend/data/backend.port');
    const p = Number(readFileSync(portFile, 'utf8').trim());
    if (Number.isInteger(p) && p > 0) return p;
  } catch { /* 文件不存在 → 默认 */ }
  return 9200;
}

const PORT = backendPort();

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
});
