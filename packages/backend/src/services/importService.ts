/**
 * 数据导入服务：长表校验入库、time_order 赋值、summary 统计
 * 对应技术方案 §4.4 设计要点 / §5.1 数据流
 */
import db, { contentHash } from '../db';
import Papa from 'papaparse';
import type { DatasetSummary, TimeSeriesRow } from '@barstudio/shared';

export interface ImportResult {
  imported: number;
  skipped: number;
  timeCount: number;
  entityCount: number;
  dataset_hash: string;
}

/** 宽松入参：value 字段可能缺失（zod 默认 schema 不强制字段存在），由后端过滤 */
export type ImportRowInput = { time_key: unknown; entity: unknown; value?: unknown };

/**
 * time_order 赋值策略（方案 §4.4）：
 * 1) 若所有 time_key 都可解析为数值 → 按数值升序（年份/月份数字等）；
 * 2) 否则按首次出现顺序（"第1期/第2期"等标签语义）。
 */
function assignTimeOrder(rows: TimeSeriesRow[]): Map<string, number> {
  const distinct = Array.from(new Set(rows.map(r => r.time_key)));
  const allNumeric = distinct.every(k => k.trim() !== '' && Number.isFinite(Number(k)));
  const ordered = allNumeric
    ? [...distinct].sort((a, b) => Number(a) - Number(b))
    : distinct; // rows 本身按出现顺序，distinct 保持首现顺序
  const map = new Map<string, number>();
  ordered.forEach((k, i) => map.set(k, i));
  return map;
}

export function importSeries(projectId: number, rows: TimeSeriesRow[]): ImportResult {
  return importSeriesRaw(projectId, rows);
}

/** 接受 {time_key,entity,value} 三元组，value 允许 string|null|undefined；内部 Number() 清洗 */
export function importSeriesRaw(projectId: number, rows: ImportRowInput[]): ImportResult {
  // 预校验：跳过空 time_key / 空 entity / value 非有限数（value 允许 string，统一 Number() 转换）
  // 注意：assignTimeOrder 必须在 valid 之后，否则原始含空格的 time_key 与 trim 后的 key 算出的 orderMap 对不上
  const stripBOM = (s: string) => s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
  const normalizeKey = (v: unknown) => stripBOM(String(v ?? '')).trim();
  const valid: TimeSeriesRow[] = rows.filter(r => {
    const tk = normalizeKey(r.time_key);
    const en = normalizeKey(r.entity);
    if (!tk || !en) return false;
    const v = typeof r.value === 'string' ? Number(r.value) : r.value;
    return Number.isFinite(v);
  }).map(r => ({
    time_key: normalizeKey(r.time_key),
    entity: normalizeKey(r.entity),
    value: typeof r.value === 'string' ? Number(r.value) : r.value as number,
  }));
  const skipped = rows.length - valid.length;

  // ★ 关键：assignTimeOrder 必须接收 trim 后的 rows，与 valid 输入一致
  const orderMap = assignTimeOrder(valid);

  const hash = contentHash(JSON.stringify(valid.map(r => [r.time_key, r.entity, r.value])));

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM time_series WHERE project_id = ?').run(projectId);
    const stmt = db.prepare(
      'INSERT INTO time_series (project_id, time_key, time_order, entity, value) VALUES (?, ?, ?, ?, ?)'
    );
    // 同一 (time, entity) 重复时保留最后一条（INSERT OR REPLACE 语义，保持幂等）
    const stmtUpsert = db.prepare(
      `INSERT INTO time_series (project_id, time_key, time_order, entity, value) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, time_order, entity) DO UPDATE SET value = excluded.value`
    );
    for (const r of valid) {
      stmtUpsert.run(projectId, r.time_key, orderMap.get(r.time_key)!, r.entity, r.value);
    }
    // 实体元数据：颜色锁定占位（NULL = 按方案自动分配）
    const entStmt = db.prepare(
      `INSERT INTO entities (project_id, entity) VALUES (?, ?)
       ON CONFLICT (project_id, entity) DO NOTHING`
    );
    const entitySet = new Set(valid.map(r => r.entity));
    for (const e of entitySet) entStmt.run(projectId, e);
    // 清掉已不存在的实体
    const delEnt = db.prepare('DELETE FROM entities WHERE project_id = ? AND entity NOT IN (SELECT DISTINCT entity FROM time_series WHERE project_id = ?)');
    delEnt.run(projectId, projectId);
    db.prepare('UPDATE projects SET dataset_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, projectId);
  });
  tx();

  const timeCount = orderMap.size;
  const entityCount = new Set(valid.map(r => r.entity)).size;
  return { imported: valid.length, skipped, timeCount, entityCount, dataset_hash: hash };
}

export function getSeries(projectId: number) {
  return db
    .prepare(
      `SELECT time_key, time_order, entity, value
       FROM time_series WHERE project_id = ?
       ORDER BY time_order ASC, value DESC, entity ASC`
    )
    .all(projectId) as { time_key: string; time_order: number; entity: string; value: number }[];
}

export function getSummary(projectId: number): DatasetSummary {
  const r = db.prepare(
    `SELECT
       COUNT(*)                     AS rowCount,
       COUNT(DISTINCT time_order)   AS timeCount,
       COUNT(DISTINCT entity)       AS entityCount,
       MIN(time_key)                AS timeMin,
       MAX(time_key)                AS timeMax,
       SUM(CASE WHEN value IS NULL THEN 1 ELSE 0 END) AS missingValues
     FROM time_series WHERE project_id = ?`
  ).get(projectId) as {
    rowCount: number; timeCount: number; entityCount: number;
    timeMin: string | null; timeMax: string | null; missingValues: number | null;
  };
  return {
    rowCount: r.rowCount ?? 0,
    timeCount: r.timeCount ?? 0,
    entityCount: r.entityCount ?? 0,
    timeMin: r.timeMin,
    timeMax: r.timeMax,
    missingValues: r.missingValues ?? 0,
  };
}

export function hasData(projectId: number): boolean {
  const r = db.prepare('SELECT COUNT(*) AS c FROM time_series WHERE project_id = ?').get(projectId) as { c: number };
  return r.c > 0;
}

/**
 * 后端侧 CSV 长表解析（multipart 文件上传 / sourceUrl 抓取用）
 * 期望表头：time, entity, value（别名兼容：时间/年份/日期 | 实体/名称/国家/公司 | 数值/值/数量）
 */
export function parseLongCsv(text: string): { rows: TimeSeriesRow[]; errors: string[] } {
  const result = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: true,
  });
  const errors: string[] = [];
  if (result.errors.length > 0) {
    errors.push(...result.errors.slice(0, 5).map(e => `第 ${e.row ?? '?'} 行解析异常: ${e.message}`));
  }
  const fields = result.meta.fields ?? [];
  const pickCol = (aliases: string[]) => fields.find(f => aliases.some(a => f.toLowerCase().includes(a.toLowerCase())));
  const timeCol = pickCol(['time', '时间', '年份', 'year', 'date', '日期', 'quarter']);
  const entityCol = pickCol(['entity', '实体', '名称', '国家', '公司', 'name', '厂商', '品牌']);
  const valueCol = pickCol(['value', '数值', '值', '数量', 'count']);
  if (!timeCol || !entityCol || !valueCol) {
    return { rows: [], errors: [`无法识别列：需要 time/entity/value 语义的列，实际表头为 [${fields.join(', ')}]。请改用前端导入做列映射。`] };
  }
  const rows: TimeSeriesRow[] = [];
  for (const rec of result.data) {
    const t = (rec[timeCol] ?? '').trim();
    const e = (rec[entityCol] ?? '').trim();
    const v = Number(rec[valueCol]);
    if (!t || !e) { errors.push(`存在空 time/entity 的行，已跳过`); continue; }
    if (!Number.isFinite(v)) { errors.push(`实体「${e}」在「${t}」的数值无法解析，已跳过`); continue; }
    rows.push({ time_key: t, entity: e, value: v });
  }
  return { rows, errors: errors.slice(0, 20) };
}
