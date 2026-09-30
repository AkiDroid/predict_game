import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './src/app.ts';

describe('api without market data', () => {
  const apps: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function makeApp() {
    const app = await buildApp({
      logger: false,
      databasePath: ':memory:',
      processedDir: path.join(os.tmpdir(), `predict-game-missing-${Date.now()}`),
      serveStatic: false,
      redisHost: 'memory',
    });
    apps.push(app);
    return app;
  }

  it('reports sqlite health and refuses bar requests until data is loaded', async () => {
    const app = await makeApp();

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    const body = health.json();
    expect(body.ok).toBe(false);
    expect(body.database).toBe('sqlite');
    expect(body.loaded).toEqual([]);
    expect(String(body.error)).toContain('预处理');

    const bars = await app.inject({ method: 'GET', url: '/api/bars?symbol=ES&tf=1m' });
    expect(bars.statusCode).toBe(401);

    const missing = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not found' });

    const names = app.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    expect(names).toContain('users');
    expect(names).toContain('sessions');
    expect(names).toContain('user_rounds');
  });

  it('registers, logs in with redis session cookie, and stores stats', async () => {
    const app = await makeApp();

    const badMe = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(badMe.statusCode).toBe(401);

    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'trader1', password: 'password1' },
    });
    expect(registered.statusCode).toBe(200);
    expect(registered.json().user.username).toBe('trader1');
    const setCookie = registered.headers['set-cookie'];
    const setCookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
    expect(setCookieStr.toLowerCase()).toContain('httponly');
    const cookie = cookieFrom(registered);
    expect(cookie).toContain('sid=');

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe('trader1');

    const round = sampleRound('r1');
    const saved = await app.inject({
      method: 'POST',
      url: '/api/stats/rounds',
      headers: { cookie },
      payload: round,
    });
    expect(saved.statusCode).toBe(200);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/stats/rounds',
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().rounds).toHaveLength(1);
    expect(listed.json().rounds[0].id).toBe('r1');

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/stats/rounds',
      headers: { cookie },
    });
    expect(afterLogout.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'trader1', password: 'password1' },
    });
    expect(login.statusCode).toBe(200);
    const cookie2 = cookieFrom(login);
    const listed2 = await app.inject({
      method: 'GET',
      url: '/api/stats/rounds',
      headers: { cookie: cookie2 },
    });
    expect(listed2.statusCode).toBe(200);
    expect(listed2.json().rounds).toHaveLength(1);
  });

  it('rejects short passwords and duplicate usernames', async () => {
    const app = await makeApp();
    const short = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'okname', password: 'short' },
    });
    expect(short.statusCode).toBe(400);

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'dupuser', password: 'password1' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'dupuser', password: 'password2' },
    });
    expect(second.statusCode).toBe(409);
  });
});

function cookieFrom(res: { headers: { 'set-cookie'?: string | string[] } }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first) throw new Error('missing set-cookie');
  return first.split(';')[0]!;
}

function sampleRound(id: string) {
  return {
    id,
    playedAt: Date.now(),
    symbol: 'ES',
    playTf: '5m',
    chartTf: '5m',
    mode: 'direction',
    predicted: 'up',
    actual: 'up',
    correct: true,
    skipped: false,
    cutoff: 1,
    nextOpen: 1,
    nextHigh: 2,
    nextLow: 1,
    nextClose: 2,
    session: 'asia',
    dayOfWeek: 1,
    hour: 10,
    barRange: 1,
    rangeBucket: 'mid',
    volBucket: 'mid',
    streakBefore: 0,
    timeToAnswerMs: 100,
  };
}
