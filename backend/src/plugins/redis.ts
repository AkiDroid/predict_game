import fp from 'fastify-plugin';
import {
  createMemorySessionStore,
  createRedisSessionStore,
  type SessionStore,
} from '../modules/auth/sessionStore.ts';

export const redisPlugin = fp(
  async (app, opts: {
    host: string;
    port: number;
    password: string;
    db: number;
  }) => {
    let sessions: SessionStore;
    if (opts.host === 'memory') {
      sessions = createMemorySessionStore();
    } else {
      sessions = await createRedisSessionStore({
        host: opts.host,
        port: opts.port,
        password: opts.password,
        db: opts.db,
      });
    }
    app.decorate('sessions', sessions);
    app.addHook('onClose', async () => {
      await sessions.close();
    });
  },
  { name: 'redis' },
);
