#!/usr/bin/env node
/**
 * 清理历史上遗留的测试项目（默认 dry-run，只列不删）
 *
 * 为什么需要它：早期各 e2e 脚本的清理代码在断言失败时会被跳过，几轮调试下来
 * 在 app.db 里积了一批测试项目。现在新跑的测试已能自动清理（见 lib-test-utils.mjs），
 * 但**已经积下的**仍需要手动清一次 —— 就是这个脚本。
 *
 * 用法：
 *   node scripts/purge_test_projects.mjs          # 列出匹配项与保留项，不删任何东西
 *   node scripts/purge_test_projects.mjs --yes    # 确认后执行删除
 *
 * 只按「测试脚本用过的命名」匹配，其余项目（含你自己导入的真实数据）一律不动。
 */
import { apiBase } from './lib-test-utils.mjs';

const PATTERNS = [
  /^e2e-/i,             // e2e-A / e2e-B / e2e-A-改
  /^BOM/i,              // BOM 专项 / BOM-CSV-multipart
  /^R2-/i,              // R2-A
  /^深度测试/,           // deep_e2e 建的
  /^单时间点测试/,        // deep_e2e 建的
  /^空数据项目/,          // deep_e2e 建的
  /^multi-test-/i,      // multi_value_e2e 建的
  /^UTF-16/,            // encoding_test 建的
  /^记录删除容错/,        // record_delete_test 建的
  /^未命名$|^未命名-/,    // 个别脚本的占位标题
];

const YES = process.argv.includes('--yes');
const BASE = apiBase();

const j = await (await fetch(`${BASE}/projects`)).json();
const all = j.data ?? [];
const hits = all.filter((p) => PATTERNS.some((re) => re.test(p.title)));
const hitIds = new Set(hits.map((p) => p.id));
const keep = all.filter((p) => !hitIds.has(p.id));

console.log(`共 ${all.length} 个项目，其中 ${hits.length} 个匹配测试命名：\n`);
for (const p of hits) {
  console.log(`  删  #${p.id}  「${p.title}」  ${p.hasData ? '有数据' : '无数据'}  成片 ${p.recordCount}`);
}
console.log(`\n保留 ${keep.length} 个：`);
for (const p of keep) {
  console.log(`  留  #${p.id}  「${p.title}」  ${p.hasData ? '有数据' : '无数据'}`);
}

if (!YES) {
  console.log('\n（dry-run：未删除任何东西。核对上面「保留」清单无误后，加 --yes 执行）');
  process.exit(0);
}

let ok = 0;
for (const p of hits) {
  try {
    const r = await fetch(`${BASE}/projects/${p.id}`, { method: 'DELETE' });
    if (r.status === 204 || r.status === 404) ok++;
  } catch { /* 单个失败不阻塞 */ }
}
console.log(`\n已删除 ${ok}/${hits.length} 个测试项目`);
