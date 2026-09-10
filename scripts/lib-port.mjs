/**
 * 读取后端实际端口（供 repo 根目录的 e2e 测试脚本使用）。
 * 优先级：PORT 环境变量 > packages/backend/data/backend.port > 9200
 */
import { readFileSync } from 'node:fs';

export function getBackendPort() {
  const envPort = Number(process.env.PORT || 0);
  if (Number.isInteger(envPort) && envPort > 0) return envPort;
  try {
    const p = Number(readFileSync(new URL('../packages/backend/data/backend.port', import.meta.url), 'utf8').trim());
    if (Number.isInteger(p) && p > 0) return p;
  } catch { /* 文件不存在 → 默认 */ }
  return 9200;
}
