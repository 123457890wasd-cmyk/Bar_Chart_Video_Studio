import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({
    data: {
      status: 'ok',
      service: 'bar-chart-video-studio-backend',
      version: '0.1.0',
      time: new Date().toISOString(),
    },
  }));
}
