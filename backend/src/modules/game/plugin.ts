import fp from 'fastify-plugin';
import { gameRoutes } from './routes.ts';

export const gamePlugin = fp(
  async (app) => {
    await gameRoutes(app);
  },
  { name: 'game', dependencies: ['market', 'auth'] },
);
