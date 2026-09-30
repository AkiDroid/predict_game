import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './src/app.ts';

describe('api without market data', () => {
  const apps: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('reports sqlite health and refuses bar requests until data is loaded', async () => {
    const app = await buildApp({
      logger: false,
      databasePath: ':memory:',
      processedDir: path.join(os.tmpdir(), `predict-game-missing-${Date.now()}`),
      serveStatic: false,
    });
    apps.push(app);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    const body = health.json();
    expect(body.ok).toBe(false);
    expect(body.database).toBe('sqlite');
    expect(body.loaded).toEqual([]);
    expect(String(body.error)).toContain('预处理');

    const bars = await app.inject({ method: 'GET', url: '/api/bars?symbol=ES&tf=1m' });
    expect(bars.statusCode).toBe(503);

    const missing = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not found' });

    const names = app.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    expect(names).toContain('users');
    expect(names).toContain('sessions');
  });
});
