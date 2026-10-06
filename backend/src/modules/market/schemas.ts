/**
 * Response schemas let Fastify serialize with fast-json-stringify. Property order
 * follows the returned objects so the bytes match JSON.stringify.
 */

export const barSchema = {
  type: 'object',
  properties: {
    t: { type: 'number' },
    o: { type: 'number' },
    h: { type: 'number' },
    l: { type: 'number' },
    c: { type: 'number' },
    v: { type: 'number' },
  },
} as const;

export const barsResponseSchema = {
  type: 'object',
  properties: {
    bars: { type: 'array', items: barSchema },
  },
} as const;
