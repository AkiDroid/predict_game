import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Direction, GameFilters, PlayMode, SymbolId, Timeframe } from '../../../../src/lib/types.ts';
import { TIMEFRAMES } from '../../../../src/lib/types.ts';
import { requireAuth } from '../auth/plugin.ts';

const SYMBOLS = ['ES', 'NQ'] as const;
const SESSIONS = ['asia', 'europe', 'america_rth', 'america_eth'] as const;

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/round/next',
    {
      preHandler: [requireAuth, requireMarket],
      schema: {
        body: {
          type: 'object',
          required: ['symbol', 'playTf'],
          additionalProperties: false,
          properties: {
            symbol: { type: 'string', enum: [...SYMBOLS] },
            playTf: { type: 'string', enum: [...TIMEFRAMES] },
            mode: { type: 'string', enum: ['direction', 'bracket'] },
            filters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                dateFrom: { type: 'integer' },
                dateTo: { type: 'integer' },
                sessions: {
                  type: 'array',
                  items: { type: 'string', enum: [...SESSIONS] },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        symbol: SymbolId;
        playTf: Timeframe;
        mode?: PlayMode;
        filters?: GameFilters;
      };
      try {
        const mode = body.mode === 'bracket' ? 'bracket' : 'direction';
        return app.engine.createRound(
          body.symbol,
          body.playTf,
          body.filters ?? {},
          mode,
          request.userId,
        );
      } catch (err) {
        return reply.status(400).send({ error: messageOf(err) });
      }
    },
  );

  app.post(
    '/api/round/reveal',
    {
      preHandler: [requireAuth, requireMarket],
      schema: {
        body: {
          type: 'object',
          required: ['roundId', 'predicted'],
          additionalProperties: false,
          properties: {
            roundId: { type: 'string', minLength: 1 },
            predicted: { type: 'string', enum: ['up', 'down'] },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { roundId: string; predicted: Direction };
      try {
        return app.engine.reveal(body.roundId, body.predicted);
      } catch (err) {
        return reply.status(400).send({ error: messageOf(err) });
      }
    },
  );

  app.post(
    '/api/round/reveal-bracket',
    {
      preHandler: [requireAuth, requireMarket],
      schema: {
        body: {
          type: 'object',
          required: ['roundId', 'direction', 'distance'],
          additionalProperties: false,
          properties: {
            roundId: { type: 'string', minLength: 1 },
            direction: { type: 'string', enum: ['up', 'down'] },
            distance: { type: 'number', exclusiveMinimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { roundId: string; direction: Direction; distance: number };
      try {
        return app.engine.revealBracket(body.roundId, body.direction, body.distance);
      } catch (err) {
        return reply.status(400).send({ error: messageOf(err) });
      }
    },
  );
}

async function requireMarket(request: FastifyRequest, reply: FastifyReply) {
  if (request.server.marketReady) return;
  return reply.status(503).send({ error: request.server.marketError || '数据未就绪' });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
