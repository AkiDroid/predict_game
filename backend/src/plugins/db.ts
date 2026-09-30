import fp from 'fastify-plugin';
import { openDatabase } from '../db/open.ts';

export const dbPlugin = fp(
  async (app, opts: { filename: string }) => {
    const db = openDatabase(opts.filename);
    app.decorate('db', db);
    app.addHook('onClose', async () => {
      db.close();
    });
  },
  { name: 'db' },
);
