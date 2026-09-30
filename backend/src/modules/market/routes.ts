import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SymbolId, Timeframe } from '../../../../src/lib/types.ts';
import { TIMEFRAMES } from '../../../../src/lib/types.ts';
import { requireAuth } from '../auth/plugin.ts';

const SYMBOLS = ['ES', 'NQ'] as const;

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: app.marketReady,
    error: app.marketError || undefined,
    loaded: app.engine.listLoaded(),
    timezone: 'America/Chicago',
    database: 'sqlite',
    pendingRounds: app.engine.countPending(),
  }));

  app.get(
    '/api/meta',
    {
      preHandler: [requireAuth, requireMarket],
      schema: {
        querystring: {
          type: 'object',
          required: ['symbol'],
          additionalProperties: false,
          properties: {
            symbol: { type: 'string', enum: [...SYMBOLS] },
            tf: { type: 'string', enum: [...TIMEFRAMES] },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as { symbol: SymbolId; tf?: Timeframe };
      return app.engine.getMeta(query.symbol, query.tf ?? '5m');
    },
  );

  app.get(
    '/api/bars',
    {
      preHandler: [requireAuth, requireMarket],
      schema: {
        querystring: {
          type: 'object',
          required: ['symbol', 'tf'],
          additionalProperties: false,
          properties: {
            symbol: { type: 'string', enum: [...SYMBOLS] },
            tf: { type: 'string', enum: [...TIMEFRAMES] },
            before: { type: 'integer' },
            after: { type: 'integer' },
            cutoff: { type: 'integer' },
            limit: { type: 'integer', minimum: 1, maximum: 8000 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as {
        symbol: SymbolId;
        tf: Timeframe;
        before?: number;
        after?: number;
        cutoff?: number;
        limit?: number;
      };
      const bars = app.engine.getBars({
        symbol: query.symbol,
        tf: query.tf,
        before: query.before,
        after: query.after,
        cutoff: query.cutoff ?? null,
        limit: query.limit ?? 800,
      });
      return { bars };
    },
  );
}

async function requireMarket(request: FastifyRequest, reply: FastifyReply) {
  if (request.server.marketReady) return;
  return reply.status(503).send({ error: request.server.marketError || '数据未就绪' });
}
