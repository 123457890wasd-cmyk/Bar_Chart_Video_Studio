import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import db, { STORAGE_DIR } from '../db';
import { createRecordSchema } from '@barstudio/shared';
import { notFound, validationError } from './projects';
import type { RecordInfo, RenderConfig } from '@barstudio/shared';

type RecordRow = {
  id: number; project_id: number; config_snapshot: string; file_path: string | null;
  format: string; width: number; height: number; fps: number;
  duration_ms: number; size_bytes: number; created_at: string;
};

function toInfo(row: RecordRow): RecordInfo {
  let cfg: RenderConfig;
  try { cfg = JSON.parse(row.config_snapshot); } catch { cfg = {} as RenderConfig; }
  return { ...row, config_snapshot: cfg };
}

export async function recordRoutes(app: FastifyInstance) {
  app.get('/records', async (req) => {
    const projectId = Number((req.query as any).projectId);
    const rows = (projectId > 0
      ? db.prepare(
          `SELECT r.*, p.title AS project_title FROM records r LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.project_id = ? ORDER BY r.created_at DESC`
        ).all(projectId)
      : db.prepare(
          `SELECT r.*, p.title AS project_title FROM records r LEFT JOIN projects p ON p.id = r.project_id
           ORDER BY r.created_at DESC`
        ).all()
    ) as (RecordRow & { project_title: string | null })[];
    return { data: rows.map(r => ({ ...toInfo(r), project_title: r.project_title ?? undefined })) };
  });

  app.post('/records', async (req, reply) => {
    const parsed = createRecordSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send(validationError(parsed.error));
    const { project_id, config_snapshot, duration_ms, size_bytes } = parsed.data;
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
    if (!project) return reply.status(404).send(notFound());
    const r = db.prepare(
      `INSERT INTO records (project_id, config_snapshot, format, width, height, fps, duration_ms, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(project_id, JSON.stringify(config_snapshot), 'mp4',
      config_snapshot.width, config_snapshot.height, config_snapshot.fps, duration_ms, size_bytes);
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(r.lastInsertRowid) as RecordRow;
    return reply.status(201).send({ data: toInfo(row) });
  });

  /** 上传产物文件存档（multipart） */
  app.post('/records/:id/file', async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined;
    if (!row) return reply.status(404).send(notFound());
    const file = await (req as any).file();
    if (!file) return reply.status(400).send({ error: { code: 'E_VALIDATION', message: '缺少文件' } });
    const ext = (file.filename || 'video.mp4').toLowerCase().endsWith('.webm') ? 'webm' : 'mp4';
    const rel = `${id}-${Date.now()}.${ext}`;
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    await pipeline(file.file, createWriteStream(path.join(STORAGE_DIR, rel)));
    const st = (await import('node:fs')).statSync(path.join(STORAGE_DIR, rel));
    db.prepare('UPDATE records SET file_path = ?, size_bytes = ?, format = ? WHERE id = ?').run(rel, st.size, ext, id);
    return reply.status(201).send({ data: { id, file_path: rel, size_bytes: st.size } });
  });

  app.get('/records/:id/file', async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined;
    if (!row) return reply.status(404).send(notFound());
    if (!row.file_path || !existsSync(path.join(STORAGE_DIR, row.file_path))) {
      return reply.status(404).send({ error: { code: 'E_NOT_FOUND', message: '成片文件不存在（可能未上传存档）' } });
    }
    const full = path.join(STORAGE_DIR, row.file_path);
    return (reply as any).send(createReadStream(full));
  });

  app.delete('/records/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined;
    if (!row) return reply.status(404).send(notFound());
    if (row.file_path) {
      const full = path.join(STORAGE_DIR, row.file_path);
      if (existsSync(full)) (await import('node:fs')).unlinkSync(full);
    }
    db.prepare('DELETE FROM records WHERE id = ?').run(id);
    return reply.status(204).send();
  });
}
