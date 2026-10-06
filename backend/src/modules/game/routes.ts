import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Direction, GameFilters, PlayMode, SamplingMode, SymbolId, Timeframe } from '../../../../src/lib/types.ts';
import { TIMEFRAMES } from '../../../../src/lib/types.ts';
import { requireAuth } from '../auth/plugin.ts';
import {
  errorResponseSchema,
  revealBracketResponseSchema,
  revealResponseSchema,
  roundNextResponseSchema,
} from './schemas.ts';

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
            sampling: { type: 'string', enum: ['random', 'balanced'] },
            atrMultiple: { type: 'number', minimum: 1, maximum: 8 },
            samplingSessionId: { type: 'string', minLength: 8, maxLength: 80 },
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
        response: { 200: roundNextResponseSchema, 400: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        symbol: SymbolId;
        playTf: Timeframe;
        mode?: PlayMode;
        sampling?: SamplingMode;
        atrMultiple?: number;
        samplingSessionId?: string;
        filters?: GameFilters;
      };
      try {
        const mode = body.mode === 'bracket' ? 'bracket' : 'direction';
        return app.engine.createRound(body.symbol, body.playTf, body.filters ?? {}, mode, request.userId, {
          sampling: body.sampling,
          atrMultiple: body.atrMultiple,
          samplingSessionId: body.samplingSessionId,
        });
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
        response: { 200: revealResponseSchema, 400: errorResponseSchema },
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
        response: { 200: revealBracketResponseSchema, 400: errorResponseSchema },
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
