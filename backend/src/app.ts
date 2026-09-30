import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { loadConfig, type AppConfig } from './config.ts';
import { dbPlugin } from './plugins/db.ts';
import { authPlugin } from './modules/auth/plugin.ts';
import { gamePlugin } from './modules/game/plugin.ts';
import { marketPlugin } from './modules/market/plugin.ts';
import './types.ts';

export interface BuildOptions extends Partial<AppConfig> {
  logger?: boolean;
}

export async function buildApp(options: BuildOptions = {}) {
  const { logger, ...overrides } = options;
  const config = loadConfig(overrides);
  const app = Fastify({ logger: logger ?? true });

  app.setErrorHandler((err, request, reply) => {
    const statusCode = typeof err === 'object' && err && 'statusCode' in err ? err.statusCode : undefined;
    const status = typeof statusCode === 'number' && statusCode >= 400 ? statusCode : 500;
    if (status >= 500) request.log.error(err);
    const message = status >= 500 ? '服务器错误' : err instanceof Error ? err.message : '请求无效';
    return reply.status(status).send({ error: message });
  });

  await app.register(cors, {
    origin: config.corsOrigin,
    credentials: true,
  });
  await app.register(dbPlugin, { filename: config.databasePath });
  await app.register(authPlugin);
  await app.register(marketPlugin, { processedDir: config.processedDir });
  await app.register(gamePlugin);

  if (config.serveStatic) {
    await app.register(fastifyStatic, { root: config.distDir });
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? request.url;
    if (config.serveStatic && !pathname.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: 'not found' });
  });

  return app;
}
