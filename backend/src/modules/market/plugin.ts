import fp from 'fastify-plugin';
import { GameEngine } from '../../../gameEngine.ts';
import { SqliteRoundStore } from '../../../roundStore.ts';
import { loadMarketData } from './loadSeries.ts';
import { marketRoutes } from './routes.ts';

export const marketPlugin = fp(
  async (app, opts: { processedDir: string }) => {
    const rounds = new SqliteRoundStore(app.db);
    rounds.expireOlderThan(Date.now());
    const engine = new GameEngine(rounds);
    app.decorate('engine', engine);
    app.decorate('marketReady', false);
    app.decorate('marketError', '');

    const loaded = loadMarketData(engine, app.db, opts.processedDir);
    app.marketReady = loaded.ok;
    app.marketError = loaded.error ?? '';
    if (loaded.ok) {
      app.log.info(`loaded ${loaded.loaded} series from ${opts.processedDir}`);
    } else {
      app.log.warn(loaded.error ?? 'market data is not ready');
    }

    await marketRoutes(app);
  },
  { name: 'market', dependencies: ['db'] },
);
