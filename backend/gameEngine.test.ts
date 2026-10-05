import { describe, expect, it } from 'vitest';
import { GameEngine } from './gameEngine.ts';
import { BarSeries } from './binary.ts';
import type { RoundStore, StoredRound } from './roundStore.ts';
import { BRACKET_MAX_BARS, firstTouch } from '../src/lib/bracket.ts';
import { censorBars } from '../src/lib/censor.ts';
import { barEndUnix, resampleOHLCV } from '../src/lib/resample.ts';
import { sessionBucket } from '../src/lib/session.ts';
import { chicagoLocalToUtcMs } from '../src/lib/time.ts';
import type { Bar, Direction, Timeframe } from '../src/lib/types.ts';

const T0 = 1_700_000_000;

class MemoryRounds implements RoundStore {
  private rows = new Map<string, StoredRound & { status: 'pending' | 'revealed' }>();

  insert(round: StoredRound): void {
    this.rows.set(round.id, { ...round, status: 'pending' });
  }

  peek(id: string): StoredRound | null {
    const row = this.rows.get(id);
    return row?.status === 'pending' ? row : null;
  }

  claim(id: string): StoredRound | null {
    const row = this.rows.get(id);
    if (!row || row.status !== 'pending') return null;
    row.status = 'revealed';
    return row;
  }

  expireOlderThan(): void {}

  countPending(): number {
    return 0;
  }
}

function bar(i: number, o: number, h: number, l: number, c: number): Bar {
  return { t: T0 + i * 60, o, h, l, c, v: 1 };
}

describe('getBars', () => {
  it('returns the same window as censoring the prefix', () => {
    for (const tf of ['5m', '1d'] as const) {
      const step = tf === '5m' ? 300 : 86_400;
      const bars: Bar[] = [];
      for (let i = 0; i < 360; i++) bars.push({ t: T0 + i * step, o: 1, h: 2, l: 0.5, c: 1.25, v: i });
      const series = new BarSeries(bars);
      const engine = new GameEngine(new MemoryRounds());
      engine.setSeries('ES', tf, series);
      const rand = mulberry32(5);
      for (let n = 0; n < 40; n++) {
        const before = rand() < 0.75 ? bars[Math.floor(rand() * bars.length)]!.t : undefined;
        const after = rand() < 0.45 ? bars[Math.floor(rand() * bars.length)]!.t : undefined;
        const anchor = bars[Math.floor(rand() * bars.length)]!;
        const cutoff = rand() < 0.6 ? barEndUnix(anchor.t, tf) : undefined;
        const limit = rand() < 0.2 ? undefined : 1 + Math.floor(rand() * 80);
        const opts = { symbol: 'ES' as const, tf, before, after, cutoff, limit };
        expect(engine.getBars(opts)).toEqual(naiveBars(series, opts));
      }
      expect(engine.getBars({ symbol: 'ES', tf, limit: 500 })).toHaveLength(360);
      expect(engine.getBars({ symbol: 'ES', tf, before: bars[0]!.t })).toEqual([]);
    }
  });
});

describe('eligible samples', () => {
  it('skips a doji target without allocating a bar per index', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 250; i++) {
      const doji = i === 201;
      bars.push(bar(i, 100, 102, 98, doji ? 100 : 101));
    }
    const engine = new GameEngine(new MemoryRounds(), () => 0);
    engine.setSeries('ES', '1m', new BarSeries(bars));
    const round = engine.createRound('ES', '1m', {}, 'direction');
    expect(round.lastBar.t).toBe(T0 + 201 * 60);
  });

  it('drops bracket samples once the ATR window goes flat', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 400; i++) {
      bars.push(i < 220 ? bar(i, 100, 102, 98, 100) : bar(i, 100, 100, 100, 100));
    }
    const series = new BarSeries(bars);
    const first = new GameEngine(new MemoryRounds(), () => 0);
    const last = new GameEngine(new MemoryRounds(), () => 0.999999999999);
    first.setSeries('ES', '1m', series);
    last.setSeries('ES', '1m', series);
    expect(first.createRound('ES', '1m', {}, 'bracket').lastBar.t).toBe(T0 + 200 * 60);
    expect(last.createRound('ES', '1m', {}, 'bracket').lastBar.t).toBe(T0 + 232 * 60);
  });

  it('applies session filters from Chicago civil time', () => {
    const start = Math.floor(chicagoLocalToUtcMs(2024, 6, 3, 0, 0) / 1000);
    const bars: Bar[] = [];
    for (let i = 0; i < 24 * 60; i++) {
      bars.push({ t: start + i * 60, o: 100, h: 101, l: 99, c: 101, v: 1 });
    }
    const engine = new GameEngine(new MemoryRounds(), () => 0);
    engine.setSeries('ES', '1m', new BarSeries(bars));
    const round = engine.createRound('ES', '1m', { sessions: ['america_rth'] }, 'direction');
    expect(round.lastBar.t).toBe(start + 510 * 60);
    expect(sessionBucket(round.lastBar.t)).toBe('america_rth');
  });
});

describe('bracket touch scan', () => {
  const start = Math.floor(chicagoLocalToUtcMs(2024, 6, 3, 9, 0) / 1000);

  function minutes(count: number, paint: (index: number) => Partial<Bar> | null): Bar[] {
    const out: Bar[] = [];
    for (let i = 0; i < count; i++) {
      const painted = paint(i);
      out.push({
        t: start + i * 60,
        o: painted?.o ?? 100,
        h: painted?.h ?? 100.25,
        l: painted?.l ?? 99.75,
        c: painted?.c ?? 100,
        v: 1,
      });
    }
    return out;
  }

  function expectMatchesMinuteWalk(m1bars: Bar[], playTf: Timeframe, distance: number, direction: Direction = 'up') {
    const m1 = new BarSeries(m1bars);
    const play = playTf === '1m' ? m1 : new BarSeries(resampleOHLCV(m1bars, playTf));
    const engine = new GameEngine(new MemoryRounds(), () => 0);
    engine.setSeries('ES', '1m', m1);
    if (playTf !== '1m') engine.setSeries('ES', playTf, play);
    const round = engine.createRound('ES', playTf, {}, 'bracket');
    const revealed = engine.revealBracket(round.roundId, direction, Math.max(round.minDistance, distance));
    const lastIdx = play.indexAtOrBefore(round.lastBar.t);
    expect(play.t[lastIdx]).toBe(round.lastBar.t);
    const nextIdx = lastIdx + 1;
    const maxIdx = Math.min(play.length - 1, nextIdx + BRACKET_MAX_BARS - 1);
    const scanUntil = barEndUnix(play.t[maxIdx]!, playTf);
    const window = m1.slice(m1.indexAtOrAfter(play.t[nextIdx]!), m1.indexAtOrAfter(scanUntil));
    const hit = firstTouch(window, revealed.entry, revealed.takeProfit, revealed.stopLoss);
    expect(revealed.outcome).toBe(hit ? hit.outcome : 'unresolved');
    expect(revealed.hitTime).toBe(hit ? hit.time : null);
    return revealed;
  }

  it('matches a full 1m walk on the 1m series', () => {
    const bars = minutes(280, (i) => (i === 240 ? { o: 100, h: 100.5, l: 90, c: 95 } : null));
    const revealed = expectMatchesMinuteWalk(bars, '1m', 5);
    expect(revealed.outcome).toBe('sl');
    expect(revealed.hitTime).toBe(start + 240 * 60);
  });

  it('skips flat hours, then hits a later stop', () => {
    const spike = 210 * 60 + 10;
    const bars = minutes(220 * 60, (i) => (i === spike ? { o: 100, h: 100.25, l: 90, c: 95 } : null));
    const revealed = expectMatchesMinuteWalk(bars, '1h', 5);
    expect(revealed.outcome).toBe('sl');
    expect(revealed.hitTime).toBe(start + spike * 60);
  });

  it('counts a gap through the target even when the hour range starts above it', () => {
    const open = 201 * 60;
    const bars = minutes(220 * 60, (i) => {
      if (i < open || i >= open + 60) return null;
      return { o: 110, h: 111, l: 109, c: 110 };
    });
    const revealed = expectMatchesMinuteWalk(bars, '1h', 5);
    expect(revealed.outcome).toBe('tp');
    expect(revealed.hitTime).toBe(start + open * 60);
  });

  it('uses 1m path order when the hour aggregate would touch the other side first', () => {
    const hour = 206 * 60;
    const bars = minutes(220 * 60, (i) => {
      if (i === hour) return { o: 100, h: 100.5, l: 96, c: 99 };
      if (i === hour + 1) return { o: 99, h: 104, l: 98.5, c: 103 };
      if (i === hour + 59) return { o: 100, h: 100.25, l: 97, c: 97 };
      return null;
    });
    const revealed = expectMatchesMinuteWalk(bars, '1h', 2);
    expect(revealed.outcome).toBe('sl');
    expect(revealed.hitTime).toBe(start + hour * 60);
  });

  it('stays unresolved when neither price is reached', () => {
    const bars = minutes(220 * 60, () => null);
    const revealed = expectMatchesMinuteWalk(bars, '1h', 40);
    expect(revealed.outcome).toBe('unresolved');
    expect(revealed.hitTime).toBeNull();
  });
});

function naiveBars(
  series: BarSeries,
  opts: { tf: Timeframe; before?: number; after?: number; cutoff?: number; limit?: number },
): Bar[] {
  const limit = Math.min(opts.limit ?? 500, 8000);
  let endIdx = series.length;
  if (opts.before != null) endIdx = series.indexAtOrAfter(opts.before);
  let candidates =
    opts.cutoff != null ? censorBars(series.slice(0, endIdx), opts.tf, opts.cutoff) : series.slice(0, endIdx);
  if (opts.after != null) {
    const i = candidates.findIndex((b) => b.t >= opts.after!);
    candidates = i < 0 ? [] : candidates.slice(i);
    return candidates.slice(0, limit);
  }
  return candidates.slice(Math.max(0, candidates.length - limit));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
