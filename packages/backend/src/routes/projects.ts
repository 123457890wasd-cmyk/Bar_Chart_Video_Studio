import type { FastifyInstance } from 'fastify';
import db from '../db';
import { hasData } from '../services/importService';
import { createProjectSchema, updateProjectSchema, DEFAULT_RENDER_CONFIG } from '@barstudio/shared';
import type { ProjectInfo, RenderConfig } from '@barstudio/shared';
import { ZodError } from 'zod';

type ProjectRow = {
  id: number; title: string; description: string | null; config: string;
  dataset_hash: string | null; created_at: string; updated_at: string;
};

function toInfo(row: ProjectRow): ProjectInfo {
  let config: RenderConfig;
  try { config = { ...DEFAULT_RENDER_CONFIG, ...JSON.parse(row.config) }; }
  catch { config = { ...DEFAULT_RENDER_CONFIG }; }
  const rc = db.prepare('SELECT COUNT(*) AS c FROM records WHERE project_id = ?').get(row.id) as { c: number };
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    config,
    dataset_hash: row.dataset_hash,
    hasData: hasData(row.id),
    recordCount: rc.c,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function projectRoutes(app: FastifyInstance) {
  app.get('/projects', async () => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
    return { data: rows.map(toInfo) };
  });

  app.post('/projects', async (req, reply) => {
    const parsed = createProjectSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send(validationError(parsed.error));
    const { title, description, config } = parsed.data;
    const full = { ...DEFAULT_RENDER_CONFIG, ...(config ?? {}) };
    const r = db.prepare(
      'INSERT INTO projects (title, description, config) VALUES (?, ?, ?)'
    ).run(title, description ?? null, JSON.stringify(full));
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid) as ProjectRow;
    return reply.status(201).send({ data: toInfo(row) });
  });

  app.get('/projects/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) return reply.status(404).send(notFound());
    return { data: toInfo(row) };
  });

  app.patch('/projects/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) return reply.status(404).send(notFound());
    const parsed = updateProjectSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send(validationError(parsed.error));
    const { title, description, config } = parsed.data;
    const merged = { ...toInfo(row).config, ...(config ?? {}) };
    db.prepare(
      `UPDATE projects SET title = ?, description = ?, config = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(title ?? row.title, description === undefined ? row.description : description, JSON.stringify(merged), id);
    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
    return { data: toInfo(updated) };
  });

  app.delete('/projects/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const r = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    if (r.changes === 0) return reply.status(404).send(notFound());
    return reply.status(204).send();
  });
}

export function notFound() {
  return { error: { code: 'E_NOT_FOUND', message: '资源不存在' } };
}

export function validationError(err: ZodError) {
  return {
    error: {
      code: 'E_VALIDATION',
      message: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    },
  };
}
