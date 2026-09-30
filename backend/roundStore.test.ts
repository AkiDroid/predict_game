import { describe, expect, it } from 'vitest';
import { openDatabase } from './src/db/open.ts';
import { ROUND_TTL_MS, SqliteRoundStore } from './roundStore.ts';

describe('sqlite schema', () => {
  it('creates account tables and rejects a session without a user', () => {
    const db = openDatabase(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    expect(names).toEqual(expect.arrayContaining(['users', 'sessions', 'rounds', 'series_catalog']));

    expect(() => {
      db.prepare(
        'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('s1', 'missing-user', 'hash', 1, 1);
    }).toThrow();
    db.close();
  });
});

describe('SqliteRoundStore', () => {
  it('claims a pending round once, then rejects a second claim', () => {
    const db = openDatabase(':memory:');
    const store = new SqliteRoundStore(db);
    store.insert({
      id: 'r1',
      userId: null,
      symbol: 'ES',
      playTf: '5m',
      mode: 'direction',
      lastIdx: 10,
      nextIdx: 11,
      cutoff: 1_700_000_000,
      volBucket: 'mid',
      createdAt: Date.now(),
    });

    expect(store.peek('r1')?.nextIdx).toBe(11);
    expect(store.claim('r1')?.lastIdx).toBe(10);
    expect(store.peek('r1')).toBeNull();
    expect(store.claim('r1')).toBeNull();
    expect(store.countPending()).toBe(0);
    db.close();
  });

  it('expires rounds older than the ttl', () => {
    const db = openDatabase(':memory:');
    const store = new SqliteRoundStore(db);
    const createdAt = Date.now() - ROUND_TTL_MS - 1000;
    store.insert({
      id: 'old',
      userId: null,
      symbol: 'NQ',
      playTf: '1h',
      mode: 'bracket',
      lastIdx: 3,
      nextIdx: 4,
      cutoff: 1_700_000_000,
      volBucket: 'low',
      createdAt,
    });

    store.expireOlderThan(Date.now());
    expect(store.peek('old')).toBeNull();
    expect(store.claim('old')).toBeNull();
    db.close();
  });
});
