import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from './src/db/open.ts';
import { EXPIRE_INTERVAL_MS, ROUND_RETENTION_MS, ROUND_TTL_MS, SqliteRoundStore } from './roundStore.ts';

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

  it('throttles expiry but never counts or answers a stale round', () => {
    const db = openDatabase(':memory:');
    const store = new SqliteRoundStore(db);
    const now = Date.now();
    const base = {
      userId: null,
      symbol: 'ES' as const,
      playTf: '5m' as const,
      mode: 'direction' as const,
      lastIdx: 1,
      nextIdx: 2,
      cutoff: 1,
      volBucket: 'mid' as const,
    };
    const status = (id: string) => db.prepare('SELECT status FROM rounds WHERE id = ?').get(id)?.status;
    store.expireOlderThan(now);
    store.insert({ ...base, id: 'fresh', createdAt: now });
    store.insert({ ...base, id: 'stale', createdAt: now - ROUND_TTL_MS - 1 });
    store.expireOlderThan(now + 1000);
    expect(status('stale')).toBe('pending');
    expect(store.countPending()).toBe(1);
    expect(store.peek('stale')).toBeNull();
    expect(status('stale')).toBe('expired');

    store.insert({ ...base, id: 'stale2', createdAt: now - ROUND_TTL_MS - 1 });
    expect(store.claim('stale2')).toBeNull();
    store.insert({ ...base, id: 'stale3', createdAt: now - ROUND_TTL_MS - 1 });
    store.expireOlderThan(now + EXPIRE_INTERVAL_MS);
    expect(status('stale3')).toBe('expired');
    expect(store.countPending()).toBe(1);
    expect(store.claim('fresh')?.id).toBe('fresh');
    expect(store.countPending()).toBe(0);
    db.close();
  });

  it('opens file databases in WAL mode with synchronous=NORMAL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-db-'));
    const db = openDatabase(path.join(dir, 'app.sqlite'));
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(1);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes finished rounds past the retention window, at most every few minutes', () => {
    const db = openDatabase(':memory:');
    const store = new SqliteRoundStore(db);
    const now = Date.now();
    const base = {
      userId: null,
      symbol: 'ES' as const,
      playTf: '5m' as const,
      mode: 'direction' as const,
      lastIdx: 1,
      nextIdx: 2,
      cutoff: 1,
      volBucket: 'mid' as const,
    };
    store.insert({ ...base, id: 'old-revealed', createdAt: now - ROUND_RETENTION_MS - 1 });
    store.insert({ ...base, id: 'old-pending', createdAt: now - ROUND_RETENTION_MS - 1 });
    store.insert({ ...base, id: 'recent', createdAt: now - ROUND_TTL_MS - 1 });
    store.claim('old-revealed');
    const ids = () => db.prepare('SELECT id FROM rounds ORDER BY id').all().map((r) => String(r.id));

    store.expireOlderThan(now);
    expect(ids()).toEqual(['recent']);

    store.insert({ ...base, id: 'late', createdAt: now - ROUND_RETENTION_MS - 1 });
    store.expireOlderThan(now + 1000);
    expect(ids()).toEqual(['late', 'recent']);
    store.expireOlderThan(now + 11 * 60 * 1000);
    expect(ids()).toEqual(['recent']);
    db.close();
  });
});

describe('user_rounds migration', () => {
  it('keys rows by (user_id, id) and keeps existing data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-migrations-'));
    const src = path.join(import.meta.dirname, 'src', 'db', 'migrations');
    for (const name of ['001_init.sql', '002_user_rounds.sql']) fs.copyFileSync(path.join(src, name), path.join(dir, name));
    const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    migrate(db, dir);
    for (const id of ['u1', 'u2']) {
      db.prepare(
        'INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
      ).run(id, `${id}@x`, 'h', id);
    }
    db.prepare('INSERT INTO user_rounds (id, user_id, played_at, payload) VALUES (?, ?, ?, ?)').run('r1', 'u1', 5, '{}');

    migrate(db, src);
    expect(db.prepare('SELECT user_id, id, played_at FROM user_rounds').all()).toEqual([
      { user_id: 'u1', id: 'r1', played_at: 5 },
    ]);
    db.prepare('INSERT INTO user_rounds (id, user_id, played_at, payload) VALUES (?, ?, ?, ?)').run('r1', 'u2', 6, '{}');
    expect(() =>
      db.prepare('INSERT INTO user_rounds (id, user_id, played_at, payload) VALUES (?, ?, ?, ?)').run('r1', 'u1', 7, '{}'),
    ).toThrow();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
