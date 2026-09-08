/**
 * 后端入口：Fastify + SQLite(单机单用户)
 * 职责克制（方案 §4.1）：只做 CRUD / 导入 / 存档，渲染与转码全在浏览器。
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { healthRoutes } from './routes/health';
import { projectRoutes } from './routes/projects';
import { datasetRoutes } from './routes/datasets';
import { recordRoutes } from './routes/records';
import { datasourceRoutes } from './routes/datasources';

const PORT = Number(process.env.PORT ?? 9200);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = Fastify({
  logger: { level: 'warn' },
  bodyLimit: 64 * 1024 * 1024, // 大表导入
});

await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: 512 * 1024 * 1024 }, // 产物视频存档上传
});

await app.register(async (v1) => {
  v1.addHook('onRoute', (route) => { route.url = `/api/v1${route.url}`; });
  await healthRoutes(v1);
  await projectRoutes(v1);
  await datasetRoutes(v1);
  await recordRoutes(v1);
  await datasourceRoutes(v1);
});

app.setErrorHandler((err, _req, reply) => {
  const e = err as any;
  const code = e.code ?? 'E_INTERNAL';
  const status = e.statusCode ?? 500;
  app.log.warn(`${status} ${code}: ${e.message}`);
  reply.status(status).send({ error: { code: status === 500 ? 'E_INTERNAL' : code, message: e.message } });
});

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[backend] listening on http://${HOST}:${PORT} (API: /api/v1)`);
});
