import type { FastifyInstance } from 'fastify';
import db from '../db';
import {
  importSeriesRaw, importSeriesMulti, getSeries, getDatasetMeta, getSummary, parseLongCsv,
} from '../services/importService';
import { importPayloadSchema, importMultiValuePayloadSchema } from '@barstudio/shared';
import { notFound, validationError } from './projects';

export async function datasetRoutes(app: FastifyInstance) {
  /** JSON 导入（主链路：前端已解析 + 列映射后的长表） */
  app.post('/projects/:id/datasets/import', async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send(notFound());
    const parsed = importPayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send(validationError(parsed.error));
    const { rows } = parsed.data;
    if (rows.length === 0) {
      return reply.status(400).send({ error: { code: 'E_EMPTY_TIMESERIES', message: '没有可导入的数据行' } });
    }
    const result = importSeriesRaw(id, rows);
    return reply.status(201).send({ data: { ...result, summary: getSummary(id) } });
  });

  /** 多值 JSON 导入（横坐标选取：同行为多列值的导入） */
  app.post('/projects/:id/datasets/import-multi', async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send(notFound());
    const parsed = importMultiValuePayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send(validationError(parsed.error));
    const result = importSeriesMulti(id, parsed.data);
    if (result.imported === 0) {
      return reply.status(400).send({
        error: { code: 'E_EMPTY_TIMESERIES', message: '多值导入：没有任何有效行' },
      });
    }
    return reply.status(201).send({ data: { ...result, summary: getSummary(id) } });
  });

  /** multipart 上传 CSV 文件（后端解析长表）或 sourceUrl 抓取 */
  app.post('/projects/:id/datasets/upload', async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send(notFound());

    let csvText = '';
    const ct = req.headers['content-type'] ?? '';

    if (ct.includes('application/json')) {
      // { sourceUrl } 抓取政府公开数据
      const body = (req.body ?? {}) as { sourceUrl?: string };
      if (!body.sourceUrl) {
        return reply.status(400).send({ error: { code: 'E_VALIDATION', message: 'sourceUrl 不能为空' } });
      }
      try {
        const res = await fetch(body.sourceUrl, { headers: { 'user-agent': 'Mozilla/5.0 bar-chart-video-studio' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        // 编码探测：UTF-8 优先，失败转 GBK
        try {
          csvText = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        } catch {
          csvText = new TextDecoder('gbk').decode(buf);
        }
      } catch (e: any) {
        return reply.status(400).send({ error: { code: 'E_CSV_PARSE', message: `抓取失败: ${e.message}` } });
      }
    } else {
      const file = await (req as any).file();
      if (!file) return reply.status(400).send({ error: { code: 'E_CSV_PARSE', message: '缺少文件' } });
      const buf = await file.toBuffer();
      try {
        csvText = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        try { csvText = new TextDecoder('gbk').decode(buf); }
        catch { csvText = new TextDecoder('utf-8').decode(buf); }
      }
    }

    const { rows, errors } = parseLongCsv(csvText);
    if (rows.length === 0) {
      return reply.status(400).send({ error: { code: 'E_CSV_PARSE', message: errors.join('; ') || 'CSV 中没有有效数据' } });
    }
    const result = importSeriesRaw(id, rows);
    return reply.status(201).send({ data: { ...result, warnings: errors, summary: getSummary(id) } });
  });

  /** 取回时序数据。可选 query 参数 ?valueColumn=name 切换当前柱长所用列。 */
  app.get('/projects/:id/datasets', async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send(notFound());
    // 切换列优先级：query 显式 > project.config.valueColumn > meta.defaultValueColumn
    const meta = getDatasetMeta(id);
    const cols = meta.valueColumns;
    const isValid = (c?: string) => Boolean(c && cols.includes(c));
    const qVc = (req.query as { valueColumn?: string }).valueColumn;
    let cfgVc: string | undefined;
    const cfgRow = db.prepare('SELECT config FROM projects WHERE id = ?').get(id) as { config: string } | undefined;
    if (cfgRow) {
      try { cfgVc = (JSON.parse(cfgRow.config).valueColumn as string | undefined); } catch { cfgVc = undefined; }
    }
    // invalid query valueColumn → 退回 project.config.valueColumn；仍无效则用 meta.default
    const vc = isValid(qVc) ? qVc
      : (isValid(cfgVc) ? cfgVc : meta.defaultValueColumn);
    return { data: getSeries(id, vc) };
  });

  app.get('/projects/:id/datasets/summary', async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send(notFound());
    return { data: getSummary(id) };
  });

  app.delete('/projects/:id/datasets', async (req, reply) => {
    const id = Number((req.params as any).id);
    const r = db.prepare('DELETE FROM time_series WHERE project_id = ?').run(id);
    db.prepare(`UPDATE projects SET dataset_hash = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
    return reply.status(200).send({ data: { deleted: r.changes } });
  });
}
