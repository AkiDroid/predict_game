import { describe, expect, it } from 'vitest';
import { censorBars, assertNoLeakage, maxVisibleOpen } from './censor';
import { resampleOHLCV, barEndUnix, bucketStartUnix } from './resample';
import { barDirection, isDoji, isWin, scoreRound } from './score';
import { computeOverall } from './stats';
import { computeStats } from '../../backend/src/modules/stats/analysis';
import { chicagoLocalToUtcMs } from './time';
import type { Bar, RoundRecord } from './types';

function bar(t: number, o: number, h: number, l: number, c: number, v = 1): Bar {
  return { t, o, h, l, c, v };
}

describe('resampleOHLCV', () => {
  it('aggregates 1m into 5m with first/max/min/last/sum', () => {
    // 10:00-10:04 Chicago → bucket 10:00
    const base = Math.floor(chicagoLocalToUtcMs(2024, 1, 2, 10, 0) / 1000);
    const bars: Bar[] = [
      bar(base, 100, 101, 99, 100.5, 10),
      bar(base + 60, 100.5, 102, 100, 101, 20),
      bar(base + 120, 101, 101.5, 100.5, 101.2, 5),
      bar(base + 300, 101.2, 103, 101, 102, 7), // next 5m bucket
    ];
    const out = resampleOHLCV(bars, '5m');
    expect(out).toHaveLength(2);
    expect(out[0].t).toBe(bucketStartUnix(base, '5m'));
    expect(out[0].o).toBe(100);
    expect(out[0].h).toBe(102);
    expect(out[0].l).toBe(99);
    expect(out[0].c).toBe(101.2);
    expect(out[0].v).toBe(35);
    expect(out[1].o).toBe(101.2);
    expect(out[1].c).toBe(102);
    expect(out[1].v).toBe(7);
  });

  it('anchors 4h buckets at the 17:00 CT session open', () => {
    const at = (d: number, h: number, m = 0) => Math.floor(chicagoLocalToUtcMs(2024, 6, d, h, m) / 1000);
    expect(bucketStartUnix(at(2, 17, 0), '4h')).toBe(at(2, 17));
    expect(bucketStartUnix(at(2, 20, 59), '4h')).toBe(at(2, 17));
    expect(bucketStartUnix(at(3, 0, 30), '4h')).toBe(at(2, 21));
    expect(bucketStartUnix(at(3, 8, 30), '4h')).toBe(at(3, 5));
    expect(bucketStartUnix(at(3, 15, 59), '4h')).toBe(at(3, 13));
    expect(bucketStartUnix(at(3, 15, 59), '1h')).toBe(at(3, 15));
    const bars: Bar[] = [];
    for (let t = at(2, 17); t < at(3, 16); t += 60) bars.push(bar(t, 1, 2, 0.5, 1.5));
    const out = resampleOHLCV(bars, '4h');
    expect(out.map((b) => b.t)).toEqual([17, 21, 1, 5, 9, 13].map((h, i) => (i < 2 ? at(2, h) : at(3, h))));
    for (let i = 1; i < out.length; i++) expect(barEndUnix(out[i - 1].t, '4h')).toBeLessThanOrEqual(out[i].t);
  });

  it('does not invent bars across gaps', () => {
    const a = Math.floor(chicagoLocalToUtcMs(2024, 1, 2, 10, 0) / 1000);
    const b = Math.floor(chicagoLocalToUtcMs(2024, 1, 2, 11, 0) / 1000);
    const bars = [bar(a, 1, 2, 1, 1.5, 1), bar(b, 3, 4, 3, 3.5, 1)];
    const out = resampleOHLCV(bars, '5m');
    expect(out).toHaveLength(2);
    expect(out[1].t - out[0].t).toBeGreaterThan(300);
  });
});

describe('censor', () => {
  it('hides bars whose period ends after cutoff T', () => {
    const t0 = Math.floor(chicagoLocalToUtcMs(2024, 1, 2, 10, 0) / 1000);
    const bars5 = [
      bar(t0, 1, 1, 1, 1),
      bar(t0 + 300, 2, 2, 2, 2),
      bar(t0 + 600, 3, 3, 3, 3),
    ];
    // Predict the 10:10 bar → cutoff = 10:10 open = t0+600
    const cutoff = t0 + 600;
    const visible = censorBars(bars5, '5m', cutoff);
    expect(visible.map((b) => b.t)).toEqual([t0, t0 + 300]);
    expect(maxVisibleOpen('5m', cutoff, bars5)).toBe(t0 + 300);
    expect(maxVisibleOpen('5m', t0, bars5)).toBe(null);
    expect(assertNoLeakage(visible, '5m', cutoff)).toBe(true);

    // Lower TF: 1m bars inside the predicted 5m candle must be hidden
    const bars1 = [
      bar(t0 + 600 - 60, 1, 1, 1, 1), // 10:09 — end 10:10 <= cutoff → visible
      bar(t0 + 600, 2, 2, 2, 2), // 10:10 — end 10:11 > cutoff → hidden
    ];
    const v1 = censorBars(bars1, '1m', cutoff);
    expect(v1).toHaveLength(1);
    expect(v1[0].t).toBe(t0 + 540);
  });

  it('hides forming higher-TF bar that includes the future', () => {
    const t0 = Math.floor(chicagoLocalToUtcMs(2024, 1, 2, 10, 0) / 1000);
    // 15m bar at 10:00 ends 10:15; cutoff at 10:05 (predicting 5m) → hide 15m 10:00
    const bars15 = [bar(t0 - 900, 1, 1, 1, 1), bar(t0, 2, 2, 2, 2)];
    const cutoff = t0 + 300; // 10:05
    const v = censorBars(bars15, '15m', cutoff);
    expect(v).toHaveLength(1);
    expect(v[0].t).toBe(t0 - 900);
    expect(barEndUnix(t0, '15m')).toBeGreaterThan(cutoff);
  });
});

describe('score / doji', () => {
  it('uses close > open for 涨', () => {
    expect(barDirection(bar(1, 10, 12, 9, 11))).toBe('up');
    expect(barDirection(bar(1, 10, 12, 9, 9))).toBe('down');
    expect(barDirection(bar(1, 10, 10, 10, 10))).toBe(null);
    expect(isDoji(bar(1, 10, 11, 9, 10))).toBe(true);
  });

  it('scores win/loss', () => {
    expect(isWin('up', 'up')).toBe(true);
    expect(isWin('up', 'down')).toBe(false);
    expect(scoreRound('up', bar(1, 10, 12, 9, 11)).correct).toBe(true);
    expect(scoreRound('up', bar(1, 10, 10, 10, 10)).correct).toBe(null);
  });
});

describe('stats aggregation', () => {
  it('computes overall win rate and streaks', () => {
    const rounds: RoundRecord[] = [
      baseRound(true),
      baseRound(true),
      baseRound(false),
      baseRound(true),
    ];
    const o = computeOverall(rounds);
    expect(o.total).toBe(4);
    expect(o.wins).toBe(3);
    expect(o.winRate).toBe(0.75);
    expect(o.maxWinStreak).toBe(2);
    expect(o.maxLossStreak).toBe(1);

    const report = computeStats(rounds);
    expect(report.bySymbol[0].n).toBe(4);
    expect(report.bySymbol[0].skips).toBe(0);
    expect(report.equity).toHaveLength(4);
    expect(report.equity[3].equity).toBe(2); // +1+1-1+1
  });

  it('counts skips without changing win rate, streak, or equity', () => {
    const skipped: RoundRecord = {
      ...baseRound(false),
      predicted: null,
      actual: null,
      correct: null,
      skipped: true,
      rangeBucket: null,
    };
    const rounds: RoundRecord[] = [
      baseRound(true),
      baseRound(true),
      skipped,
      baseRound(false),
    ];
    const o = computeOverall(rounds);
    expect(o.total).toBe(4);
    expect(o.answered).toBe(3);
    expect(o.skips).toBe(1);
    expect(o.wins).toBe(2);
    expect(o.losses).toBe(1);
    expect(o.winRate).toBeCloseTo(2 / 3);
    expect(o.skipRate).toBeCloseTo(0.25);
    expect(o.currentStreakType).toBe('loss');
    expect(o.currentStreak).toBe(1);
    expect(o.maxWinStreak).toBe(2);

    const report = computeStats(rounds);
    expect(report.bySymbol[0].n).toBe(3);
    expect(report.bySymbol[0].skips).toBe(1);
    expect(report.bySymbol[0].winRate).toBeCloseTo(2 / 3);
    expect(report.byPredicted.every((s) => s.skips === 0)).toBe(true);
    expect(report.equity).toHaveLength(3);
    expect(report.equity[2].equity).toBe(1); // +1+1-1
  });
});

function baseRound(correct: boolean): RoundRecord {
  return {
    id: Math.random().toString(36).slice(2),
    playedAt: Date.now(),
    symbol: 'ES',
    playTf: '5m',
    chartTf: '5m',
    predicted: correct ? 'up' : 'down',
    actual: 'up',
    correct,
    cutoff: 1,
    nextOpen: 1,
    nextHigh: 2,
    nextLow: 1,
    nextClose: 1.5,
    session: 'america_rth',
    dayOfWeek: 1,
    hour: 10,
    barRange: 0.5,
    rangeBucket: 'mid',
    volBucket: 'mid',
    streakBefore: 0,
    timeToAnswerMs: 1000,
  };
}
