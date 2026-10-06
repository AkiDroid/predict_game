import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeBars } from '../../../binary.ts';
import { buildApp } from '../../app.ts';
import { resampleOHLCV } from '../../../../src/lib/resample.ts';
import { chicagoLocalToUtcMs } from '../../../../src/lib/time.ts';
import type { Bar, Timeframe } from '../../../../src/lib/types.ts';
import { TIMEFRAMES } from '../../../../src/lib/types.ts';

type App = Awaited<ReturnType<typeof buildApp>>;

/** Random-walk 1m bars on a quarter-point grid, with some dojis and odd volumes. */
function minuteBars(days: number, seed: number): Bar[] {
  let a = seed;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const start = Math.floor(chicagoLocalToUtcMs(2024, 3, 4, 17, 0) / 1000);
  const out: Bar[] = [];
  let px = 5123.25;
  for (let i = 0; i < days * 1440; i++) {
    const t = start + i * 60;
    if (((t / 60) % 1440) % 97 === 0) continue;
    const o = px;
    const c = rand() < 0.2 ? o : o + Math.round((rand() - 0.5) * 12) * 0.25;
    const h = Math.max(o, c) + Math.round(rand() * 4) * 0.25;
    const l = Math.min(o, c) - Math.round(rand() * 4) * 0.25;
    out.push({ t, o, h, l, c, v: Math.round(rand() * 900) + (i % 7 === 0 ? 0.5 : 0) });
    px = c;
  }
  return out;
}

describe('round and bar responses', () => {
  let app: App;
  let dir: string;
  let cookie: string;
  const captured: unknown[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-routes-'));
    for (const [symbol, seed] of [['ES', 1], ['NQ', 2]] as const) {
      fs.mkdirSync(path.join(dir, symbol));
      // Daily rounds need 200 bars of context.
      const m1 = minuteBars(220, seed);
      for (const tf of TIMEFRAMES as Timeframe[]) {
        const bars = tf === '1m' ? m1 : resampleOHLCV(m1, tf);
        fs.writeFileSync(path.join(dir, symbol, `${tf}.bin`), encodeBars(symbol, tf, bars));
      }
    }
    app = await buildApp({ logger: false, databasePath: ':memory:', processedDir: dir, serveStatic: false, redisHost: 'memory' });
    for (const method of ['createRound', 'reveal', 'revealBracket', 'getBars'] as const) {
      const original = app.engine[method].bind(app.engine) as (...args: unknown[]) => unknown;
      (app.engine as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        const result = original(...args);
        captured.push(method === 'getBars' ? { bars: result } : result);
        return result;
      };
    }
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'schema1', password: 'password1' },
    });
    const raw = registered.headers['set-cookie'];
    cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function call(method: 'GET' | 'POST', url: string, payload?: object): Promise<{ status: number; body: string; sent: string }> {
    captured.length = 0;
    const res = await app.inject({ method, url, payload, headers: { cookie } });
    const sent = captured.length ? JSON.stringify(captured[captured.length - 1]) : '';
    return { status: res.statusCode, body: res.payload, sent };
  }

  it('serializes bars exactly like JSON.stringify', async () => {
    for (const tf of TIMEFRAMES) {
      for (const query of ['', '&limit=50', '&cutoff=1709700000', '&before=1709800000&limit=3000']) {
        const res = await call('GET', `/api/bars?symbol=ES&tf=${tf}${query}`);
        expect(res.status).toBe(200);
        expect(res.body).toBe(res.sent);
      }
    }
    const res = await call('GET', '/api/bars?symbol=NQ&tf=1m&after=1999999999');
    expect(res.body).toBe('{"bars":[]}');
  });

  it('serializes rounds and reveals exactly like JSON.stringify', async () => {
    const outcomes = new Set<string>();
    for (let n = 0; n < 60; n++) {
      const tf = TIMEFRAMES[n % TIMEFRAMES.length]!;
      const mode = n % 2 ? 'bracket' : 'direction';
      const next = await call('POST', '/api/round/next', {
        symbol: n % 3 ? 'ES' : 'NQ',
        playTf: tf,
        mode,
        sampling: n % 4 < 2 ? 'random' : 'balanced',
        ...(n % 5 === 0 ? { filters: { sessions: ['asia', 'america_rth'] } } : {}),
      });
      expect(next.status, next.body).toBe(200);
      expect(next.body).toBe(next.sent);
      const round = JSON.parse(next.body) as { roundId: string; minDistance: number };
      if (mode === 'direction') {
        const revealed = await call('POST', '/api/round/reveal', { roundId: round.roundId, predicted: n % 4 ? 'up' : 'down' });
        expect(revealed.status, revealed.body).toBe(200);
        expect(revealed.body).toBe(revealed.sent);
      } else {
        const distance = round.minDistance * [1, 2, 4, 1000][n % 4]!;
        const revealed = await call('POST', '/api/round/reveal-bracket', { roundId: round.roundId, direction: 'down', distance });
        expect(revealed.status, revealed.body).toBe(200);
        expect(revealed.body).toBe(revealed.sent);
        outcomes.add(JSON.parse(revealed.body).outcome);
      }
    }
    expect(outcomes).toContain('unresolved');
    expect(outcomes.size).toBeGreaterThan(1);

    const again = await call('POST', '/api/round/reveal', { roundId: 'missing', predicted: 'up' });
    expect(again.status).toBe(400);
    expect(JSON.parse(again.body).error).toContain('回合已失效');
  });
});
