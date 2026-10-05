import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { PlayMode, SymbolId, Timeframe, VolBucket } from '../src/lib/types.ts';
import { TIMEFRAMES } from '../src/lib/types.ts';

/** Pending rounds stay answerable for one hour, then they expire. */
export const ROUND_TTL_MS = 60 * 60 * 1000;
/** Revealed and expired rounds are deleted after this long. */
export const ROUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

/** Server-side round secret. `userId` stays null until login exists. */
export interface StoredRound {
  id: string;
  userId: string | null;
  symbol: SymbolId;
  playTf: Timeframe;
  mode: PlayMode;
  lastIdx: number;
  nextIdx: number;
  cutoff: number;
  volBucket: VolBucket;
  createdAt: number;
}

export interface RoundStore {
  insert(round: StoredRound): void;
  /** Pending, unexpired round, or null. Does not consume it. */
  peek(id: string): StoredRound | null;
  /** Mark a still-pending round revealed. Returns null if it was already taken or expired. */
  claim(id: string): StoredRound | null;
  expireOlderThan(nowMs: number): void;
  countPending(): number;
}

export class SqliteRoundStore implements RoundStore {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly selectStmt: StatementSync;
  private readonly markStmt: StatementSync;
  private readonly expireStmt: StatementSync;
  private readonly countStmt: StatementSync;
  private readonly purgeStmt: StatementSync;
  private lastPurgeAt = Number.NEGATIVE_INFINITY;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO rounds (
        id, user_id, symbol, play_tf, mode, last_idx, next_idx, cutoff, vol_bucket, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `);
    this.selectStmt = db.prepare('SELECT * FROM rounds WHERE id = ?');
    this.markStmt = db.prepare(
      'UPDATE rounds SET status = ?, revealed_at = ? WHERE id = ? AND status = \'pending\'',
    );
    this.expireStmt = db.prepare(`
      UPDATE rounds
      SET status = 'expired', revealed_at = ?
      WHERE status = 'pending' AND created_at < ?
    `);
    this.countStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM rounds WHERE status = \'pending\'',
    );
    this.purgeStmt = db.prepare(
      'DELETE FROM rounds WHERE status IN (\'revealed\', \'expired\') AND created_at < ?',
    );
  }

  insert(round: StoredRound): void {
    this.insertStmt.run(
      round.id,
      round.userId,
      round.symbol,
      round.playTf,
      round.mode,
      round.lastIdx,
      round.nextIdx,
      round.cutoff,
      round.volBucket,
      round.createdAt,
    );
  }

  peek(id: string): StoredRound | null {
    const row = this.selectStmt.get(id);
    if (!row || row.status !== 'pending') return null;
    const round = toStoredRound(row);
    if (round.createdAt < Date.now() - ROUND_TTL_MS) {
      this.markStmt.run('expired', Date.now(), id);
      return null;
    }
    return round;
  }

  claim(id: string): StoredRound | null {
    const now = Date.now();
    return this.transaction(() => {
      const row = this.selectStmt.get(id);
      if (!row || row.status !== 'pending') return null;
      const round = toStoredRound(row);
      if (round.createdAt < now - ROUND_TTL_MS) {
        this.markStmt.run('expired', now, id);
        return null;
      }
      const result = this.markStmt.run('revealed', now, id);
      if (Number(result.changes) !== 1) return null;
      return round;
    });
  }

  expireOlderThan(nowMs: number): void {
    this.expireStmt.run(nowMs, nowMs - ROUND_TTL_MS);
    if (nowMs - this.lastPurgeAt >= PURGE_INTERVAL_MS) {
      this.lastPurgeAt = nowMs;
      this.purgeStmt.run(nowMs - ROUND_RETENTION_MS);
    }
  }

  countPending(): number {
    const row = this.countStmt.get();
    return row ? asInt(row.n, 'n') : 0;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

function toStoredRound(row: Record<string, SQLOutputValue>): StoredRound {
  return {
    id: asText(row.id, 'id'),
    userId: row.user_id == null ? null : asText(row.user_id, 'user_id'),
    symbol: asSymbol(asText(row.symbol, 'symbol')),
    playTf: asTimeframe(asText(row.play_tf, 'play_tf')),
    mode: asMode(asText(row.mode, 'mode')),
    lastIdx: asInt(row.last_idx, 'last_idx'),
    nextIdx: asInt(row.next_idx, 'next_idx'),
    cutoff: asInt(row.cutoff, 'cutoff'),
    volBucket: asVol(asText(row.vol_bucket, 'vol_bucket')),
    createdAt: asInt(row.created_at, 'created_at'),
  };
}

function asText(value: SQLOutputValue, field: string): string {
  if (typeof value !== 'string') throw new Error(`回合字段 ${field} 类型异常`);
  return value;
}

function asInt(value: SQLOutputValue, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`回合字段 ${field} 类型异常`);
}

function asSymbol(value: string): SymbolId {
  if (value === 'ES' || value === 'NQ') return value;
  throw new Error(`未知品种: ${value}`);
}

function asTimeframe(value: string): Timeframe {
  if ((TIMEFRAMES as readonly string[]).includes(value)) return value as Timeframe;
  throw new Error(`未知周期: ${value}`);
}

function asMode(value: string): PlayMode {
  if (value === 'direction' || value === 'bracket') return value;
  throw new Error(`未知模式: ${value}`);
}

function asVol(value: string): VolBucket {
  if (value === 'low' || value === 'mid' || value === 'high') return value;
  throw new Error(`未知波动分位: ${value}`);
}
