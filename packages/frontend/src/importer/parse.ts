/**
 * 前端导入解析器：CSV / XLSX / 粘贴表格 → 规范表；宽表 → 长表（方案 §1.2 / §5.1）
 * 编码策略（方案 §9）：BOM 探测 → UTF-8 严格 → GBK → 兜底替换
 */
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { TimeSeriesRow } from '@barstudio/shared';

export interface ParsedTable {
  fields: string[];
  rows: string[][];
  source: 'csv' | 'xlsx' | 'text';
}

export interface ColumnMapping {
  time: string;
  entity: string;
  value: string;
}

export type TableMode = 'long' | 'wide-by-row' | 'wide-by-col';
// long:        每行 = (time, entity, value)
// wide-by-row: 第一列 = 时间，其余各列 = 实体（政府 CSV 常见）
// wide-by-col: 第一列 = 实体，其余各列 = 时间

/** 文本解码：BOM 剥离 → UTF-8 严格 → GBK → 兜底替换（方案 §9） */
export async function decodeFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      text = new TextDecoder('utf-8').decode(buf);
    }
  }
  return stripBOM(text);
}

/** 去掉开头 BOM 字符（UTF-8 \uFEFF / UTF-16 LE / BE 等） */
export function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

export function parseDelimitedText(text: string): ParsedTable {
  const t0 = stripBOM(text).trim();

  // 全角分隔符归一化（Excel 中文版默认导出 ',' ';' '"' 等全角字符）
  // 仅当第一行主要是全角标点时才替换，避免破坏字符串内的 ASCII 标点
  const firstLineRaw = t0.split(/\r?\n/)[0] ?? '';
  const cnComma = (firstLineRaw.match(/，/g) ?? []).length;
  const enComma = (firstLineRaw.match(/,/g) ?? []).length;
  const useFullWidthComma = cnComma >= Math.max(1, enComma);
  const t = useFullWidthComma ? t0.replace(/，/g, ',').replace(/；/g, ';') : t0;

  const firstLine = t.split(/\r?\n/)[0] ?? '';
  const isTsv = firstLine.includes('\t') && !firstLine.includes(',') && !firstLine.includes(';');
  const result = Papa.parse<string[]>(t, {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter: isTsv ? '\t' : '',
  });
  const rows = (result.data as string[][]).map(r => r.map(c => (c ?? '').trim()));
  const fields = rows.shift() ?? [];
  return { fields, rows, source: 'text' };
}

export function parseCsvFile(text: string): ParsedTable {
  const result = Papa.parse<string[]>(stripBOM(text).trim(), {
    header: false,
    skipEmptyLines: 'greedy',
  });
  const rows = (result.data as string[][]).map(r => r.map(c => (c ?? '').trim()));
  // 字段名也去 BOM（防止 header 第一个字段被污染导致列映射失效）
  const fields = (rows.shift() ?? []).map(f => stripBOM(f));
  return { fields, rows, source: 'csv' };
}

export async function parseXlsxFile(file: File): Promise<ParsedTable> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '' });
  const rows = aoa.map(r => r.map(c => String(c ?? '').trim()));
  const fields = (rows.shift() ?? []).map((f, i) => (f ? f : `列${i + 1}`));
  return { fields, rows, source: 'xlsx' };
}

export async function parseFile(file: File): Promise<ParsedTable> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return parseXlsxFile(file);
  const text = await decodeFile(file);
  if (name.endsWith('.json')) {
    // JSON 长表 [{time, entity, value}]
    try {
      const arr = JSON.parse(text);
      const rows = Array.isArray(arr) ? arr : [];
      const fields = rows.length ? Object.keys(rows[0]) : [];
      return { fields, rows: rows.map((r: any) => fields.map(f => String(r[f] ?? ''))), source: 'csv' };
    } catch {
      throw new Error('JSON 解析失败：请提供长表数组');
    }
  }
  return parseCsvFile(text);
}

/** 自动猜列头（方案 §3.2）：列名语义 → 兜底启发式 */
export function guessMapping(table: ParsedTable): ColumnMapping | null {
  const { fields, rows } = table;
  if (fields.length < 3) return null;
  const find = (aliases: string[]) =>
    fields.find(f => aliases.some(a => f.toLowerCase().includes(a.toLowerCase())));

  let time = find(['time', '时间', '年份', 'year', '日期', 'date', 'quarter', '季度']);
  let entity = find(['entity', '实体', '名称', '国家', '公司', 'name', '厂商', '品牌', '地区', '城市']);
  let value = find(['value', '数值', '值', '数量', 'count', '产量', '销量', '出货量']);

  if (!time || !entity || !value) {
    // 兜底：找数值比例最高的列作 value，第一列作 time、第二列作 entity
    const numericRatio = (ci: number) => {
      const nonEmpty = rows.filter(r => (r[ci] ?? '') !== '');
      if (nonEmpty.length === 0) return 0;
      const numeric = nonEmpty.filter(r => Number.isFinite(Number(r[ci].replace(/[,，]/g, ''))));
      return numeric.length / nonEmpty.length;
    };
    const ratios = fields.map((_, i) => (i < 2 ? -1 : numericRatio(i)));
    const valueIdx = ratios.indexOf(Math.max(...ratios));
    if (valueIdx < 2) return null;
    time = fields[0];
    entity = fields[1];
    value = fields[valueIdx];
  }
  return { time, entity, value };
}

export interface ToLongResult {
  rows: TimeSeriesRow[];
  errors: string[];
  warnings: string[];
}

/** 规范表 → 长表（按模式转换 + 数值清洗报告） */
export function toLongRows(
  table: ParsedTable,
  mode: TableMode,
  mapping?: ColumnMapping
): ToLongResult {
  const { fields, rows } = table;
  const errors: string[] = [];
  const warnings: string[] = [];
  const out: TimeSeriesRow[] = [];

  const toNumber = (raw: string): number | null => {
    const cleaned = raw.replace(/[,，\s%¥$]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '—') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  if (mode === 'long') {
    if (!mapping) return { rows: [], errors: ['缺少列映射'], warnings };
    const ti = fields.indexOf(mapping.time);
    const ei = fields.indexOf(mapping.entity);
    const vi = fields.indexOf(mapping.value);
    if (ti < 0 || ei < 0 || vi < 0) return { rows: [], errors: ['列映射无效：所选列不在表中'], warnings };
    for (const r of rows) {
      const t = (r[ti] ?? '').trim();
      const e = (r[ei] ?? '').trim();
      const v = toNumber(r[vi] ?? '');
      if (!t || !e) { warnings.push(`空时间/实体行已跳过: [${r.join(', ')}]`); continue; }
      if (v === null) { warnings.push(`「${e}」在「${t}」的数值「${r[vi]}」无法解析，已跳过`); continue; }
      out.push({ time_key: t, entity: e, value: v });
    }
  } else if (mode === 'wide-by-row') {
    // 第一列 = 时间，其余列 = 实体
    for (const r of rows) {
      const t = (r[0] ?? '').trim();
      if (!t) { warnings.push('存在空时间行，已跳过'); continue; }
      for (let j = 1; j < fields.length; j++) {
        const e = fields[j];
        const v = toNumber(r[j] ?? '');
        if (v === null) {
          if ((r[j] ?? '') !== '') warnings.push(`「${t}」时「${e}」的数值无法解析，已按缺失处理`);
          continue;
        }
        out.push({ time_key: t, entity: e, value: v });
      }
    }
  } else {
    // wide-by-col：第一列 = 实体，其余列 = 时间
    for (const r of rows) {
      const e = (r[0] ?? '').trim();
      if (!e) { warnings.push('存在空实体行，已跳过'); continue; }
      for (let j = 1; j < fields.length; j++) {
        const t = fields[j];
        const v = toNumber(r[j] ?? '');
        if (v === null) {
          if ((r[j] ?? '') !== '') warnings.push(`「${e}」在「${t}」的数值无法解析，已按缺失处理`);
          continue;
        }
        out.push({ time_key: t, entity: e, value: v });
      }
    }
  }

  if (out.length === 0) errors.push('没有解析出有效数据行，请检查列映射或表格模式');
  const uniqWarnings = [...new Set(warnings)];
  return { rows: out, errors, warnings: uniqWarnings.slice(0, 20) };
}
