import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { RoundRecord } from '../../../../src/lib/types.ts';
import { requireAuth } from '../auth/plugin.ts';

/** A full bracket record serializes to well under 1 KB. */
export const MAX_ROUND_BYTES = 4096;
export const MAX_ROUNDS_PER_USER = 100_000;
const MAX_ROUND_ID = 80;

export const statsPlugin = fp(
  async (app) => {
    await statsRoutes(app);
  },
  { name: 'stats', dependencies: ['db', 'auth'] },
);

async function statsRoutes(app: FastifyInstance): Promise<void> {
  const countStmt = app.db.prepare('SELECT COUNT(*) AS n FROM user_rounds WHERE user_id = ?');
  const countFor = (userId: string) => Number((countStmt.get(userId) as { n: number | bigint }).n);
  const capError = `对局记录已达上限（${MAX_ROUNDS_PER_USER} 条），请先清空统计`;

  app.get(
    '/api/stats/rounds',
    { preHandler: requireAuth },
    async (request) => {
      const rows = app.db
        .prepare(
          `SELECT payload FROM user_rounds
           WHERE user_id = ?
           ORDER BY played_at ASC, id ASC`,
        )
        .all(request.userId!) as { payload: string }[];
      const rounds: RoundRecord[] = [];
      for (const row of rows) {
        try {
          rounds.push(JSON.parse(row.payload) as RoundRecord);
        } catch {
          // skip corrupt row
        }
      }
      return { rounds };
    },
  );

  app.post(
    '/api/stats/rounds',
    {
      preHandler: requireAuth,
      bodyLimit: MAX_ROUND_BYTES * 2,
      schema: {
        body: {
          type: 'object',
          required: ['id', 'playedAt', 'symbol', 'playTf', 'chartTf'],
          additionalProperties: true,
        },
      },
    },
    async (request, reply) => {
      const round = request.body as RoundRecord;
      const checked = checkRound(round);
      if ('error' in checked) return reply.status(400).send({ error: checked.error });

      const existing = app.db
        .prepare('SELECT 1 FROM user_rounds WHERE user_id = ? AND id = ?')
        .get(request.userId!, round.id);
      if (existing) return reply.status(409).send({ error: '对局记录已存在' });
      if (countFor(request.userId!) >= MAX_ROUNDS_PER_USER) {
        return reply.status(413).send({ error: capError });
      }

      app.db
        .prepare(
          `INSERT INTO user_rounds (id, user_id, played_at, payload)
           VALUES (?, ?, ?, ?)`,
        )
        .run(round.id, request.userId!, round.playedAt, checked.payload);
      return { ok: true };
    },
  );

  app.post(
    '/api/stats/migrate',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['rounds'],
          additionalProperties: false,
          properties: {
            rounds: { type: 'array', maxItems: 20000 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { rounds: RoundRecord[] };
      if (!Array.isArray(body.rounds)) {
        return reply.status(400).send({ error: 'rounds 无效' });
      }

      const existing = countFor(request.userId!);
      if (existing > 0) {
        return { migrated: false, count: existing };
      }

      const insert = app.db.prepare(
        `INSERT OR IGNORE INTO user_rounds (id, user_id, played_at, payload)
         VALUES (?, ?, ?, ?)`,
      );
      let inserted = 0;
      app.db.exec('BEGIN');
      try {
        for (const round of body.rounds) {
          if (inserted >= MAX_ROUNDS_PER_USER) break;
          const checked = checkRound(round);
          if ('error' in checked) continue;
          const result = insert.run(round.id, request.userId!, round.playedAt, checked.payload);
          inserted += Number(result.changes);
        }
        app.db.exec('COMMIT');
      } catch (err) {
        app.db.exec('ROLLBACK');
        throw err;
      }
      return { migrated: true, count: inserted };
    },
  );

  app.delete(
    '/api/stats/rounds',
    { preHandler: requireAuth },
    async (request) => {
      app.db.prepare('DELETE FROM user_rounds WHERE user_id = ?').run(request.userId!);
      return { ok: true };
    },
  );
}

function checkRound(round: RoundRecord): { payload: string } | { error: string } {
  if (!round || typeof round !== 'object' || Array.isArray(round)) return { error: '记录无效' };
  if (typeof round.id !== 'string' || !round.id) return { error: '缺少 id' };
  if (round.id.length > MAX_ROUND_ID) return { error: 'id 过长' };
  if (!Number.isFinite(round.playedAt)) return { error: '缺少 playedAt' };
  if (typeof round.symbol !== 'string') return { error: '缺少 symbol' };
  if (typeof round.playTf !== 'string') return { error: '缺少 playTf' };
  if (typeof round.chartTf !== 'string') return { error: '缺少 chartTf' };
  const payload = JSON.stringify(round);
  if (Buffer.byteLength(payload, 'utf8') > MAX_ROUND_BYTES) {
    return { error: `单条记录不能超过 ${MAX_ROUND_BYTES} 字节` };
  }
  return { payload };
}
