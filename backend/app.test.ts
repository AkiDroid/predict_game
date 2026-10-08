import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './src/app.ts';
import { randomRounds } from '../src/lib/__fixtures__/randomRounds';
import * as reference from '../src/lib/__fixtures__/statsReference';
import type { RoundRecord } from '../src/lib/types';
import { MAX_ROUNDS_PER_USER } from './src/modules/stats/plugin.ts';

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

  it('scopes round ids per user and caps record size', async () => {
    const app = await makeApp();
    const register = async (username: string) =>
      cookieFrom(
        await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: { username, password: 'password1' },
        }),
      );
    const alice = await register('alice1');
    const bob = await register('bob001');
    const post = (cookie: string, payload: object) =>
      app.inject({ method: 'POST', url: '/api/stats/rounds', headers: { cookie }, payload });

    expect((await post(alice, sampleRound('same'))).statusCode).toBe(200);
    expect((await post(bob, sampleRound('same'))).statusCode).toBe(200);
    expect((await post(alice, sampleRound('same'))).statusCode).toBe(409);

    const bloated = await post(alice, { ...sampleRound('big'), junk: 'x'.repeat(5000) });
    expect(bloated.statusCode).toBe(400);
    expect(bloated.json().error).toContain('4096');
    const huge = await post(alice, { ...sampleRound('huge'), junk: 'x'.repeat(20000) });
    expect(huge.statusCode).toBe(413);

    const carol = await register('carol1');
    const migrated = await app.inject({
      method: 'POST',
      url: '/api/stats/migrate',
      headers: { cookie: carol },
      payload: {
        rounds: [sampleRound('m1'), sampleRound('m1'), sampleRound('m2'), { ...sampleRound('m3'), junk: 'x'.repeat(5000) }],
      },
    });
    expect(migrated.json()).toEqual({ migrated: true, count: 2 });
  });

  it('returns stored rounds in play order, skips corrupt rows, and reports me from the session', async () => {
    const app = await makeApp();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'Order1', password: 'password1' },
    });
    const cookie = cookieFrom(registered);
    const userId = registered.json().user.id as string;

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toEqual({ user: { id: userId, username: 'Order1', displayName: 'Order1' } });

    const empty = await app.inject({ method: 'GET', url: '/api/stats/rounds', headers: { cookie } });
    expect(empty.statusCode).toBe(200);
    expect(empty.headers['content-type']).toContain('application/json');
    expect(empty.json()).toEqual({ rounds: [] });

    const post = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/stats/rounds', headers: { cookie }, payload });
    expect((await post({ ...sampleRound('b'), playedAt: 200 })).statusCode).toBe(200);
    expect((await post({ ...sampleRound('a'), playedAt: 200 })).statusCode).toBe(200);
    expect((await post({ ...sampleRound('c'), playedAt: 100, note: 'é"\\' })).statusCode).toBe(200);
    app.db
      .prepare('INSERT INTO user_rounds (user_id, id, played_at, payload) VALUES (?, ?, ?, ?)')
      .run(userId, 'broken', 150, '{"id":"broken",');

    const listed = await app.inject({ method: 'GET', url: '/api/stats/rounds', headers: { cookie } });
    const rounds = listed.json().rounds as { id: string; note?: string }[];
    expect(rounds.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(rounds[0]!.note).toBe('é"\\');
    expect(rounds[1]).toEqual({ ...sampleRound('a'), playedAt: 200 });

    const odd = ['\uffff', '😀', 'Z', 'a2', 'a10', 'é', '-'];
    for (let k = 0; k < 40; k++) {
      const id = `${odd[k % odd.length]}${Math.floor(k / odd.length) || ''}`;
      expect((await post({ ...sampleRound(id), playedAt: 300 + (k % 4) })).statusCode).toBe(200);
    }
    const expected = app.db
      .prepare(
        'SELECT id FROM user_rounds WHERE user_id = ? AND json_valid(payload) ORDER BY played_at, id',
      )
      .all(userId)
      .map((r) => String(r.id));
    const relisted = await app.inject({ method: 'GET', url: '/api/stats/rounds', headers: { cookie } });
    expect((relisted.json().rounds as { id: string }[]).map((r) => r.id)).toEqual(expected);
    const report = await app.inject({ method: 'GET', url: '/api/stats/report', headers: { cookie } });
    expect(report.json()).toEqual(reference.computeStats(relisted.json().rounds as RoundRecord[]));
    const recent = await app.inject({ method: 'GET', url: '/api/stats/recent', headers: { cookie } });
    expect(recent.json().rounds).toEqual([...relisted.json().rounds].reverse());
  });

  it('keeps 409 for duplicates and 413 at the per-user cap', async () => {
    const app = await makeApp();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'capper', password: 'password1' },
    });
    const cookie = cookieFrom(registered);
    const userId = registered.json().user.id as string;
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/stats/rounds', headers: { cookie }, payload });

    expect((await post(sampleRound('first'))).statusCode).toBe(200);
    app.db
      .prepare(
        `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
         INSERT INTO user_rounds (user_id, id, played_at, payload)
         SELECT ?, 'fill-' || i, i, '{}' FROM seq`,
      )
      .run(MAX_ROUNDS_PER_USER - 2, userId);

    expect((await post(sampleRound('first'))).statusCode).toBe(409);
    expect((await post(sampleRound('last'))).statusCode).toBe(200);
    expect((await post(sampleRound('last'))).statusCode).toBe(409);
    expect((await post(sampleRound('first'))).statusCode).toBe(409);
    const over = await post(sampleRound('over'));
    expect(over.statusCode).toBe(413);
    expect(over.json().error).toContain(String(MAX_ROUNDS_PER_USER));

    const migrated = await app.inject({
      method: 'POST',
      url: '/api/stats/migrate',
      headers: { cookie },
      payload: { rounds: [sampleRound('m1')] },
    });
    expect(migrated.json()).toEqual({ migrated: false, count: MAX_ROUNDS_PER_USER });

    const cleared = await app.inject({ method: 'DELETE', url: '/api/stats/rounds', headers: { cookie } });
    expect(cleared.statusCode).toBe(200);
    const listed = await app.inject({ method: 'GET', url: '/api/stats/rounds', headers: { cookie } });
    expect(listed.json()).toEqual({ rounds: [] });
  });

  it('drops the session of a deleted user and skips session lookups outside /api', async () => {
    const app = await makeApp();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ghost1', password: 'password1' },
    });
    const cookie = cookieFrom(registered);
    const sid = cookie.slice('sid='.length);

    const realGet = app.sessions.get.bind(app.sessions);
    let lookups = 0;
    app.sessions.get = (id) => {
      lookups++;
      return realGet(id);
    };
    await app.inject({ method: 'GET', url: '/assets/index.js', headers: { cookie } });
    await app.inject({ method: 'GET', url: '/stats', headers: { cookie } });
    expect(lookups).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
    expect(lookups).toBe(1);

    app.db.prepare('DELETE FROM users WHERE id = ?').run(registered.json().user.id);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
    expect(await realGet(sid)).toBeNull();
  });

  it('computes account reports and filters bounded recent history on the server', async () => {
    const app = await makeApp();
    for (const url of ['/api/stats/report', '/api/stats/recent']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    const registered = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { username: 'statsuser', password: 'password1' },
    });
    const cookie = cookieFrom(registered);
    const userId = registered.json().user.id as string;
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
    expect((await get('/api/stats/report')).json()).toEqual(reference.computeStats([]));
    expect((await get('/api/stats/recent')).json()).toEqual({ rounds: [] });

    const rounds = randomRounds(42, 145).map((r, i) => ({
      ...r, id: String(i).padStart(3, '0'), playedAt: Math.floor(i / 3),
    }));
    // Legacy records without a mode still belong to direction; import in reverse order.
    delete rounds[0]!.mode;
    const migrated = await app.inject({
      method: 'POST', url: '/api/stats/migrate', headers: { cookie },
      payload: { rounds: [...rounds].reverse() },
    });
    expect(migrated.json().count).toBe(rounds.length);
    // Invalid JSON written out of band is ignored by both endpoints.
    app.db.prepare('INSERT INTO user_rounds (user_id, id, played_at, payload) VALUES (?, ?, ?, ?)')
      .run(userId, 'corrupt', 999, '{');
    const report = await get('/api/stats/report');
    expect(report.statusCode).toBe(200);
    expect(report.json()).toEqual(reference.computeStats(rounds));
    const recent = await get('/api/stats/recent');
    expect(recent.statusCode).toBe(200);
    expect(recent.json().rounds).toEqual([...rounds].reverse().slice(0, 100));

    for (const query of ['symbol=ES', 'playTf=5m', 'mode=direction', 'symbol=NQ&playTf=1h&mode=bracket']) {
      const params = new URLSearchParams(query);
      const expected = [...rounds].reverse().filter((r) =>
        (!params.has('symbol') || r.symbol === params.get('symbol')) &&
        (!params.has('playTf') || r.playTf === params.get('playTf')) &&
        (!params.has('mode') || (r.mode ?? 'direction') === params.get('mode')),
      ).slice(0, 100);
      const response = await get(`/api/stats/recent?${query}`);
      expect(response.statusCode).toBe(200);
      expect(response.json().rounds).toEqual(expected);
    }
    for (const query of ['symbol=invalid', 'playTf=2m', 'mode=invalid']) {
      expect((await get(`/api/stats/recent?${query}`)).statusCode).toBe(400);
    }
    expect((await get('/api/stats/report')).json()).toEqual(report.json());

    const other = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { username: 'statsother', password: 'password1' },
    });
    for (const url of ['/api/stats/report', '/api/stats/recent']) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: cookieFrom(other) } });
      expect(response.json()).toEqual(url.endsWith('report') ? reference.computeStats([]) : { rounds: [] });
    }
    const added = { ...rounds[0]!, id: 'new-win', playedAt: 1000, skipped: false, correct: true };
    expect((await app.inject({
      method: 'POST', url: '/api/stats/rounds', headers: { cookie }, payload: added,
    })).statusCode).toBe(200);
    expect((await get('/api/stats/report')).json()).toEqual(reference.computeStats([...rounds, added]));
    await app.inject({ method: 'DELETE', url: '/api/stats/rounds', headers: { cookie } });
    expect((await get('/api/stats/report')).json()).toEqual(reference.computeStats([]));
    expect((await get('/api/stats/recent')).json()).toEqual({ rounds: [] });
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
