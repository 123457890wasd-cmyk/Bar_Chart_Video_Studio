/**
 * 测试脚本共用的「跑完自动清理」工具
 *
 * 背景：各 e2e 脚本本来都会在末尾删掉自己建的项目，但那一行在断言失败 / 抛错
 * 时会被跳过 —— 几轮调试下来就在 app.db 里积了 49 个测试项目（e2e-A / BOM 专项 / R2-A …）。
 *
 * 做法：**入口快照 + 出口比对**。脚本开始时记下当前所有项目 id，结束时列出「本次新增的」
 * 并逐个删除。不依赖脚本内部记得删哪些，也不怕中途失败：
 *   - 正常跑完 → 脚本末尾显式 await cleanup()
 *   - 断言失败但没抛错 → 同样走到末尾的 cleanup()
 *   - 抛错 / 未处理的 Promise 拒绝 → 进程级钩子兜底清理后再退出
 *
 * 用法（.mjs 支持顶层 await）：
 *   import { installAutoCleanup, apiBase } from './lib-test-utils.mjs';
 *   const BASE = apiBase();
 *   const cleanup = await installAutoCleanup(BASE);
 *   ... 测试主体 ...
 *   await cleanup();
 *   process.exit(fail ? 1 : 0);
 */
import { getBackendPort } from './lib-port.mjs';

export function apiBase() {
  return `http://127.0.0.1:${getBackendPort()}/api/v1`;
}

async function listProjectIds(base) {
  const r = await fetch(`${base}/projects`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`GET /projects → ${r.status}`);
  const j = await r.json();
  return new Set((j.data ?? []).map((p) => Number(p.id)));
}

/**
 * 注册自动清理，返回 cleanup()。
 * 后端不可用时返回 no-op（脚本自身的请求会先报错，这里不添乱）。
 */
export async function installAutoCleanup(base) {
  let b = base;
  if (!b) {
    try { b = apiBase(); } catch { return async () => {}; }
  }
  let before;
  try {
    before = await listProjectIds(b);
  } catch {
    return async () => {};
  }
  const apiRoot = b;

  let done = false;
  async function cleanup() {
    if (done) return;
    done = true;
    try {
      const now = await listProjectIds(apiRoot);
      const created = [...now].filter((id) => !before.has(id));
      let ok = 0;
      for (const id of created) {
        try {
          const r = await fetch(`${apiRoot}/projects/${id}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(8000),
          });
          if (r.status === 204 || r.status === 404) ok++;
        } catch {
          /* 单个失败不阻塞其余清理 */
        }
      }
      if (created.length) {
        console.log(`\n[cleanup] 已清理本次新建的测试项目 ${ok}/${created.length}`);
      }
    } catch (e) {
      console.error('[cleanup] 清理失败：', e?.message ?? e);
    }
  }

  const bail = (err, code) => {
    console.error('\n测试异常终止：', err?.stack ?? err);
    // cleanup 是异步的，这里显式串起来再退出
    cleanup().finally(() => process.exit(code));
  };
  process.on('uncaughtException', (e) => bail(e, 2));
  process.on('unhandledRejection', (e) => bail(e, 2));

  return cleanup;
}
