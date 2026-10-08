import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { RoundRecord } from '../../../../src/lib/types.ts';
import { computeStats } from './analysis.ts';
import type { RecentRoundsFilters } from '../../../../src/lib/statsTypes.ts';
import { TIMEFRAMES } from '../../../../src/lib/types.ts';
import { requireAuth } from '../auth/plugin.ts';

/** A full bracket record serializes to well under 1 KB. */
export const MAX_ROUND_BYTES = 4096;
export const MAX_ROUNDS_PER_USER = 100_000;
const MAX_ROUND_ID = 80;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

export const statsPlugin = fp(
  async (app) => {
    await statsRoutes(app);
  },
  { name: 'stats', dependencies: ['db', 'auth'] },
);

async function statsRoutes(app: FastifyInstance): Promise<void> {
  const countStmt = app.db.prepare('SELECT COUNT(*) AS n FROM user_rounds WHERE user_id = ?');
  const countFor = (userId: string) => Number((countStmt.get(userId) as { n: number | bigint }).n);
  const hasAnyStmt = app.db.prepare('SELECT 1 FROM user_rounds WHERE user_id = ? LIMIT 1');
  const existsStmt = app.db.prepare('SELECT 1 FROM user_rounds WHERE user_id = ? AND id = ?');
  // Payloads are written with JSON.stringify; json_valid still drops rows corrupted out of band
  // so the concatenated body is always valid JSON. Ordering by played_at alone is served by
  // user_rounds_user_played_idx without a sort; ties are ordered by id in listBody.
  const listStmt = app.db.prepare(
    `SELECT played_at, id, payload
       FROM user_rounds
      WHERE user_id = ? AND json_valid(payload)
      ORDER BY played_at ASC`,
  );
  listStmt.setReturnArrays(true);
  const insertUnderCapStmt = app.db.prepare(
    `INSERT INTO user_rounds (id, user_id, played_at, payload)
     SELECT ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM user_rounds WHERE user_id = ?) < ?`,
  );
  const insertIgnoreStmt = app.db.prepare(
    `INSERT OR IGNORE INTO user_rounds (id, user_id, played_at, payload)
     VALUES (?, ?, ?, ?)`,
  );
  const deleteStmt = app.db.prepare('DELETE FROM user_rounds WHERE user_id = ?');
  const capError = `对局记录已达上限（${MAX_ROUNDS_PER_USER} 条），请先清空统计`;

  const recentStmt = app.db.prepare(
    `SELECT payload FROM user_rounds
      WHERE user_id = ? AND json_valid(payload)
        AND (? IS NULL OR json_extract(payload, '$.symbol') = ?)
        AND (? IS NULL OR json_extract(payload, '$.playTf') = ?)
        AND (? IS NULL OR COALESCE(json_extract(payload, '$.mode'), 'direction') = ?)
      ORDER BY played_at DESC, id DESC LIMIT 100`,
  );

  app.get('/api/stats/report', { preHandler: requireAuth }, async (request) => {
    const rows = listStmt.all(request.userId!) as unknown as ListRow[];
    const rounds = orderedRows(rows).map((row) => JSON.parse(row[2]) as RoundRecord);
    return computeStats(rounds);
  });

  app.get<{ Querystring: RecentRoundsFilters }>(
    '/api/stats/recent',
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            symbol: { type: 'string', enum: ['ES', 'NQ'] },
            playTf: { type: 'string', enum: TIMEFRAMES },
            mode: { type: 'string', enum: ['direction', 'bracket'] },
          },
        },
      },
    },
    async (request) => {
      const { symbol = null, playTf = null, mode = null } = request.query;
      const rows = recentStmt.all(request.userId!, symbol, symbol, playTf, playTf, mode, mode);
      return { rounds: rows.map((row) => JSON.parse(String(row.payload)) as RoundRecord) };
    },
  );

  app.get(
    '/api/stats/rounds',
    { preHandler: requireAuth },
    async (request, reply) => {
      const rows = listStmt.all(request.userId!) as unknown as ListRow[];
      return reply.type('application/json; charset=utf-8').send(listBody(rows));
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

      const userId = request.userId!;
      let changes: number;
      try {
        const result = insertUnderCapStmt.run(
          round.id,
          userId,
          round.playedAt,
          checked.payload,
          userId,
          MAX_ROUNDS_PER_USER,
        );
        changes = Number(result.changes);
      } catch (err) {
        if (isPrimaryKeyConflict(err)) return reply.status(409).send({ error: '对局记录已存在' });
        throw err;
      }
      if (changes === 0) {
        // At the cap the insert is skipped before the PK check; duplicates still report 409.
        if (existsStmt.get(userId, round.id)) return reply.status(409).send({ error: '对局记录已存在' });
        return reply.status(413).send({ error: capError });
      }
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

      if (hasAnyStmt.get(request.userId!)) {
        return { migrated: false, count: countFor(request.userId!) };
      }

      let inserted = 0;
      app.db.exec('BEGIN');
      try {
        for (const round of body.rounds) {
          if (inserted >= MAX_ROUNDS_PER_USER) break;
          const checked = checkRound(round);
          if ('error' in checked) continue;
          const result = insertIgnoreStmt.run(round.id, request.userId!, round.playedAt, checked.payload);
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
      deleteStmt.run(request.userId!);
      return { ok: true };
    },
  );
}

type ListRow = [playedAt: number, id: string, payload: string];

/** `{"rounds":[...]}` in `ORDER BY played_at, id` order, built from rows sorted by played_at only. */
export function listBody(rows: ListRow[]): string {
  return `{"rounds":[${orderedRows(rows).map((row) => row[2]).join(',')}]}`;
}

/** Keep chronological statistics consistent with the history endpoint, including timestamp ties. */
function orderedRows(rows: ListRow[]): ListRow[] {
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (j < rows.length && rows[j]![0] === rows[i]![0]) j++;
    if (j - i > 1) {
      const tie = rows.slice(i, j).sort((a, b) => compareSqliteText(a[1], b[1]));
      for (let k = 0; k < tie.length; k++) rows[i + k] = tie[k]!;
    }
    i = j;
  }
  return rows;
}

/** SQLite's default BINARY collation compares UTF-8 bytes, which differs from JS for astral chars. */
function compareSqliteText(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function isPrimaryKeyConflict(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'errcode' in err &&
    (err as { errcode: unknown }).errcode === SQLITE_CONSTRAINT_PRIMARYKEY
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
