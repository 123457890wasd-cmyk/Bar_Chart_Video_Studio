/**
 * 数据导入服务：长表校验入库、time_order 赋值、summary 统计
 * 对应技术方案 §4.4 设计要点 / §5.1 数据流
 *
 * 支持两种导入形态：
 *  1) 单值：rows = [{time_key, entity, value}]
 *  2) 多值：rows = [{time_key, entity, values: {原始: x, 插值: y, 填补: z}}]
 *  多值时 value 字段存「当前选中列的值」，values_json 存完整列映射。
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
  valueColumns: string[];
  defaultValueColumn: string;
}

/** 宽松入参：value 字段可能缺失（zod 默认 schema 不强制字段存在），由后端过滤 */
export type ImportRowInput = { time_key: unknown; entity: unknown; value?: unknown };

/** 多值入参：以 values 对象 + columns 清单承载 */
export interface ImportMultiValueInput {
  rows: { time_key: unknown; entity: unknown; values?: Record<string, unknown> }[];
  valueColumns: string[];
  defaultValueColumn?: string;
}

function assignTimeOrder(rows: TimeSeriesRow[]): Map<string, number> {
  const distinct = Array.from(new Set(rows.map(r => r.time_key)));
  const allNumeric = distinct.every(k => k.trim() !== '' && Number.isFinite(Number(k)));
  const ordered = allNumeric
    ? [...distinct].sort((a, b) => Number(a) - Number(b))
    : distinct;
  const map = new Map<string, number>();
  ordered.forEach((k, i) => map.set(k, i));
  return map;
}

function stripBOM(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}
function normalizeKey(v: unknown): string {
  return stripBOM(String(v ?? '')).trim();
}
function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

export function importSeries(projectId: number, rows: ImportRowInput[]): ImportResult {
  return importSeriesRaw(projectId, rows);
}

/** 单值导入 */
export function importSeriesRaw(projectId: number, rows: ImportRowInput[]): ImportResult {
  const valid: TimeSeriesRow[] = rows.filter(r => {
    const tk = normalizeKey(r.time_key);
    const en = normalizeKey(r.entity);
    if (!tk || !en) return false;
    return toNumOrNull(r.value) !== null;
  }).map(r => ({
    time_key: normalizeKey(r.time_key),
    entity: normalizeKey(r.entity),
    value: toNumOrNull(r.value) as number,
  }));
  const skipped = rows.length - valid.length;
  const orderMap = assignTimeOrder(valid);
  const hash = contentHash(JSON.stringify(valid.map(r => [r.time_key, r.entity, r.value])));

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM time_series WHERE project_id = ?').run(projectId);
    const stmt = db.prepare(
      `INSERT INTO time_series (project_id, time_key, time_order, entity, value, values_json) VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT (project_id, time_order, entity) DO UPDATE SET value = excluded.value, values_json = NULL`
    );
    for (const r of valid) {
      stmt.run(projectId, r.time_key, orderMap.get(r.time_key)!, r.entity, r.value);
    }
    upsertEntities(projectId, valid.map(r => r.entity));
    writeDatasetMeta(projectId, ['value'], 'value');
    db.prepare('UPDATE projects SET dataset_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, projectId);
  });
  tx();

  return {
    imported: valid.length, skipped,
    timeCount: orderMap.size,
    entityCount: new Set(valid.map(r => r.entity)).size,
    dataset_hash: hash,
    valueColumns: ['value'],
    defaultValueColumn: 'value',
  };
}

/** 多值导入 */
export function importSeriesMulti(projectId: number, payload: ImportMultiValueInput): ImportResult {
  const cols = payload.valueColumns.map(c => normalizeKey(c)).filter(Boolean);
  if (cols.length === 0) {
    return { imported: 0, skipped: payload.rows.length, timeCount: 0, entityCount: 0, dataset_hash: '', valueColumns: [], defaultValueColumn: '' };
  }
  const defaultCol = normalizeKey(payload.defaultValueColumn ?? cols[0]);
  const activeCol = cols.includes(defaultCol) ? defaultCol : cols[0];

  const valid: { time_key: string; entity: string; values: Record<string, number | null> }[] = [];
  let skipped = 0;
  for (const r of payload.rows) {
    const tk = normalizeKey(r.time_key);
    const en = normalizeKey(r.entity);
    if (!tk || !en) { skipped++; continue; }
    const src = r.values ?? {};
    const cleanedValues: Record<string, number | null> = {};
    let anyValid = false;
    for (const col of cols) {
      const n = toNumOrNull(src[col]);
      cleanedValues[col] = n;
      if (n !== null) anyValid = true;
    }
    if (!anyValid) { skipped++; continue; }
    valid.push({ time_key: tk, entity: en, values: cleanedValues });
  }

  const synthetic: TimeSeriesRow[] = valid.map(r => ({
    time_key: r.time_key, entity: r.entity, value: r.values[activeCol] ?? 0,
  }));
  const orderMap = assignTimeOrder(synthetic);

  const hash = contentHash(JSON.stringify({
    cols,
    rows: valid.map(r => [r.time_key, r.entity, ...cols.map(c => r.values[c])]),
  }));

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM time_series WHERE project_id = ?').run(projectId);
    const stmt = db.prepare(
      `INSERT INTO time_series (project_id, time_key, time_order, entity, value, values_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, time_order, entity) DO UPDATE SET
         value = excluded.value,
         values_json = excluded.values_json`
    );
    for (const r of valid) {
      const primaryVal = r.values[activeCol] ?? 0;
      stmt.run(
        projectId, r.time_key, orderMap.get(r.time_key)!, r.entity, primaryVal,
        JSON.stringify(r.values)
      );
    }
    upsertEntities(projectId, valid.map(r => r.entity));
    writeDatasetMeta(projectId, cols, activeCol);
    db.prepare('UPDATE projects SET dataset_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, projectId);
  });
  tx();

  return {
    imported: valid.length, skipped,
    timeCount: orderMap.size,
    entityCount: new Set(valid.map(r => r.entity)).size,
    dataset_hash: hash,
    valueColumns: cols,
    defaultValueColumn: activeCol,
  };
}

function upsertEntities(projectId: number, entities: string[]) {
  const entStmt = db.prepare(
    `INSERT INTO entities (project_id, entity) VALUES (?, ?)
     ON CONFLICT (project_id, entity) DO NOTHING`
  );
  for (const e of entities) entStmt.run(projectId, e);
  db.prepare('DELETE FROM entities WHERE project_id = ? AND entity NOT IN (SELECT DISTINCT entity FROM time_series WHERE project_id = ?)').run(projectId, projectId);
}

function writeDatasetMeta(projectId: number, valueColumns: string[], defaultValueColumn: string) {
  db.prepare(
    `INSERT INTO datasets_meta (project_id, value_columns, default_value_column) VALUES (?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET value_columns = excluded.value_columns, default_value_column = excluded.default_value_column`
  ).run(projectId, JSON.stringify(valueColumns), defaultValueColumn);
}

export function getDatasetMeta(projectId: number): { valueColumns: string[]; defaultValueColumn: string } {
  const row = db.prepare('SELECT value_columns, default_value_column FROM datasets_meta WHERE project_id = ?').get(projectId) as { value_columns: string; default_value_column: string } | undefined;
  if (!row) return { valueColumns: ['value'], defaultValueColumn: 'value' };
  let cols: string[];
  try {
    const arr = JSON.parse(row.value_columns);
    cols = Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0) : ['value'];
  } catch {
    cols = ['value'];
  }
  if (cols.length === 0) cols = ['value'];
  return { valueColumns: cols, defaultValueColumn: row.default_value_column || cols[0] };
}

/** 取回时序数据；多值模式下同时返回 values 与 valueColumns */
export function getSeries(projectId: number, valueColumn?: string): {
  series: { time_key: string; time_order: number; entity: string; value: number; values?: Record<string, number | null> }[];
  valueColumns: string[];
  effectiveValueColumn: string;
} {
  const meta = getDatasetMeta(projectId);
  const cols = meta.valueColumns;
  const isMulti = cols.length > 1 || cols[0] !== 'value';
  const activeCol = valueColumn && cols.includes(valueColumn) ? valueColumn : meta.defaultValueColumn;

  if (!isMulti) {
    const rows = db.prepare(
      `SELECT time_key, time_order, entity, value
       FROM time_series WHERE project_id = ?
       ORDER BY time_order ASC, value DESC, entity ASC`
    ).all(projectId) as { time_key: string; time_order: number; entity: string; value: number }[];
    return { series: rows, valueColumns: cols, effectiveValueColumn: activeCol };
  }

  const rows = db.prepare(
    `SELECT time_key, time_order, entity, value, values_json
     FROM time_series WHERE project_id = ?
     ORDER BY time_order ASC, value DESC, entity ASC`
  ).all(projectId) as { time_key: string; time_order: number; entity: string; value: number; values_json: string | null }[];

  const series = rows.map(r => {
    let parsedValues: Record<string, number | null> = {};
    try {
      const obj = r.values_json ? JSON.parse(r.values_json) : {};
      parsedValues = (obj && typeof obj === 'object') ? obj : {};
    } catch { /* ignore */ }
    // 根据请求的 valueColumn 选取实际 value（缺/null 归 0）；r.value 仅作单值兼容 fallback
    let chosen: number;
    if (Object.prototype.hasOwnProperty.call(parsedValues, activeCol)) {
      const raw = parsedValues[activeCol];
      chosen = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    } else {
      chosen = r.value;
    }
    return {
      time_key: r.time_key,
      time_order: r.time_order,
      entity: r.entity,
      value: chosen,
      values: parsedValues,
    };
  });
  return { series, valueColumns: cols, effectiveValueColumn: activeCol };
}

export function getSummary(projectId: number): DatasetSummary {
  const r = db.prepare(
    `SELECT
       COUNT(*)                     AS rowCount,
       COUNT(DISTINCT time_order)   AS timeCount,
       COUNT(DISTINCT entity)       AS entityCount,
       MIN(time_key)                AS timeMin,
       MAX(time_key)                AS timeMax
     FROM time_series WHERE project_id = ?`
  ).get(projectId) as {
    rowCount: number; timeCount: number; entityCount: number;
    timeMin: string | null; timeMax: string | null;
  };
  const meta = getDatasetMeta(projectId);
  let missingValues = 0;
  const cols = meta.valueColumns;
  if (cols.length > 1 || cols[0] !== 'value') {
    const rs = db.prepare('SELECT values_json FROM time_series WHERE project_id = ?').all(projectId) as { values_json: string | null }[];
    for (const row of rs) {
      try {
        const v = row.values_json ? JSON.parse(row.values_json) : {};
        for (const col of cols) if (v[col] === null || v[col] === undefined) missingValues++;
      } catch { /* ignore */ }
    }
  }
  return {
    rowCount: r.rowCount ?? 0,
    timeCount: r.timeCount ?? 0,
    entityCount: r.entityCount ?? 0,
    timeMin: r.timeMin,
    timeMax: r.timeMax,
    missingValues,
    valueColumns: cols,
    activeValueColumn: meta.defaultValueColumn,
  };
}

export function hasData(projectId: number): boolean {
  const r = db.prepare('SELECT COUNT(*) AS c FROM time_series WHERE project_id = ?').get(projectId) as { c: number };
  return r.c > 0;
}

/** 后端侧 CSV 长表解析 */
export function parseLongCsv(text: string): { rows: TimeSeriesRow[]; errors: string[] } {
  // BOM 探测：Excel/记事本另存的 UTF-8 CSV 会带 \uFEFF 首字符。
  // 不剥会污染第一个列头（"时间" → "\uFEFF时间"），让 pickCol 全部失配。
  const cleaned = stripBOM(text).trim();
  const result = Papa.parse<Record<string, string>>(cleaned, {
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
