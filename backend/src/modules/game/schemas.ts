/**
 * Response schemas let Fastify serialize with fast-json-stringify. Property order
 * follows the objects GameEngine returns so the bytes match JSON.stringify;
 * `additionalProperties: true` passes through any field added later.
 */
import { barSchema } from '../market/schemas.ts';

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;
const nullable = <T extends object>(schema: T) => ({ ...schema, nullable: true }) as const;

export const errorResponseSchema = {
  type: 'object',
  additionalProperties: true,
  properties: { error: str },
} as const;

const decisionMeta = {
  session: str,
  hour: num,
  dayOfWeek: num,
} as const;

export const roundNextResponseSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    roundId: str,
    symbol: str,
    playTf: str,
    cutoff: num,
    lastBar: barSchema,
    atr: num,
    atrPct: num,
    recentReturn: num,
    volBucket: str,
    ...decisionMeta,
    minDistance: num,
    defaultAtrMultiple: num,
  },
} as const;

export const revealResponseSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    nextBar: barSchema,
    actual: str,
    correct: { type: 'boolean' },
    predicted: str,
    meta: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ...decisionMeta,
        barRange: num,
        rangeBucket: str,
        volBucket: str,
        cutoff: num,
        nextBarEnd: num,
        nextBar: barSchema,
        symbol: str,
        playTf: str,
      },
    },
  },
} as const;

export const revealBracketResponseSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    outcome: str,
    correct: nullable({ type: 'boolean' }),
    direction: str,
    predicted: str,
    actual: nullable(str),
    entry: num,
    takeProfit: num,
    stopLoss: num,
    distance: num,
    atr: num,
    barsToHit: nullable(num),
    hitTime: nullable(num),
    revealUntil: num,
    hitBar: nullable(barSchema),
    meta: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ...decisionMeta,
        barRange: num,
        rangeBucket: nullable(str),
        volBucket: str,
        cutoff: num,
        nextBarEnd: num,
        symbol: str,
        playTf: str,
      },
    },
  },
} as const;
