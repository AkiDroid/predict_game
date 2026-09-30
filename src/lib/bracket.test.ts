import { describe, expect, it } from 'vitest';
import {
  bracketFromPointer,
  firstTouch,
  minBracketDistance,
  resolveOhlcTouch,
  snapDistance,
} from './bracket';
import { computeOverall, currentStreakValue } from './stats';
import type { RoundRecord } from './types';

function bar(t: number, o: number, h: number, l: number, c: number) {
  return { t, o, h, l, c, v: 1 };
}

describe('bracket distance', () => {
  it('keeps an exact tick multiple and ceils anything above it', () => {
    expect(minBracketDistance(10, 0.25)).toBe(10);
    expect(minBracketDistance(10.25, 0.25)).toBe(10.25);
    expect(minBracketDistance(10.01, 0.25)).toBe(10.25);
    expect(minBracketDistance(0, 0.25)).toBe(0.25);
  });

  it('never snaps below the minimum', () => {
    expect(snapDistance(10.1, 10.25, 0.25)).toBe(10.25);
    expect(snapDistance(10.4, 10.25, 0.25)).toBe(10.5);
    expect(snapDistance(3, 2, 0.25)).toBe(3);
  });
});

describe('bracketFromPointer', () => {
  const entry = 100;
  const min = 2;

  it('clamps a long take-profit to 1 ATR and mirrors the stop', () => {
    const b = bracketFromPointer(entry, 100.5, 'tp', min, 0.25);
    expect(b.direction).toBe('up');
    expect(b.distance).toBe(2);
    expect(b.takeProfit).toBe(102);
    expect(b.stopLoss).toBe(98);
  });

  it('widens both sides together', () => {
    const b = bracketFromPointer(entry, 104.1, 'tp', min, 0.25);
    expect(b.direction).toBe('up');
    expect(b.distance).toBe(4);
    expect(b.takeProfit).toBe(104);
    expect(b.stopLoss).toBe(96);
  });

  it('flips to short when take-profit is dragged through entry', () => {
    const b = bracketFromPointer(entry, 96, 'tp', min, 0.25);
    expect(b.direction).toBe('down');
    expect(b.takeProfit).toBe(96);
    expect(b.stopLoss).toBe(104);
  });

  it('treats a stop dragged above entry as a short', () => {
    const b = bracketFromPointer(entry, 105, 'sl', min, 0.25);
    expect(b.direction).toBe('down');
    expect(b.stopLoss).toBe(105);
    expect(b.takeProfit).toBe(95);
    expect(Math.abs(b.takeProfit - entry)).toBe(Math.abs(b.stopLoss - entry));
  });
});

describe('firstTouch', () => {
  const entry = 100;
  const tp = 102;
  const sl = 98;

  it('wins when take-profit is touched on a later bar', () => {
    const hit = firstTouch(
      [bar(1, 100, 101, 99.5, 100.5), bar(2, 100.5, 102.25, 100.25, 102)],
      entry,
      tp,
      sl,
    );
    expect(hit).toMatchObject({ outcome: 'tp', index: 1, time: 2 });
  });

  it('loses when the stop is touched first', () => {
    expect(firstTouch([bar(1, 100, 100.5, 97.75, 98.25)], entry, tp, sl)?.outcome).toBe('sl');
  });

  it('counts a gap through take-profit before the rest of the bar', () => {
    expect(resolveOhlcTouch(100, 103, 104, 90, 91, tp, sl)).toBe('tp');
  });

  it('walks a bullish bar down before up, so a spanning bar hits the stop first', () => {
    expect(firstTouch([bar(1, 100, 103, 97, 102)], entry, tp, sl)?.outcome).toBe('sl');
  });

  it('walks a bearish bar up before down, so a spanning bar hits take-profit first', () => {
    expect(firstTouch([bar(1, 100, 103, 97, 98)], entry, tp, sl)?.outcome).toBe('tp');
  });

  it('returns null while price stays inside the bracket', () => {
    expect(firstTouch([bar(1, 100, 101.5, 98.5, 101)], entry, tp, sl)).toBeNull();
  });
});

describe('unresolved bracket rounds', () => {
  it('do not change win rate or break a streak', () => {
    const rounds: RoundRecord[] = [
      round(true),
      round(true),
      unresolved(),
      round(false),
    ];
    const o = computeOverall(rounds);
    expect(o.answered).toBe(3);
    expect(o.wins).toBe(2);
    expect(o.losses).toBe(1);
    expect(o.unresolved).toBe(1);
    expect(o.skips).toBe(0);
    expect(o.winRate).toBeCloseTo(2 / 3);
    expect(currentStreakValue(rounds)).toBe(-1);
    expect(o.maxWinStreak).toBe(2);
  });
});

function round(correct: boolean): RoundRecord {
  return {
    id: 'r',
    playedAt: 1,
    symbol: 'ES',
    playTf: '5m',
    chartTf: '5m',
    mode: 'direction',
    predicted: 'up',
    actual: correct ? 'up' : 'down',
    correct,
    cutoff: 1,
    nextOpen: 1,
    nextHigh: 2,
    nextLow: 1,
    nextClose: 1,
    session: 'america_rth',
    dayOfWeek: 1,
    hour: 10,
    barRange: 1,
    rangeBucket: 'mid',
    volBucket: 'mid',
    streakBefore: 0,
    timeToAnswerMs: 1,
  };
}

function unresolved(): RoundRecord {
  return {
    ...round(false),
    mode: 'bracket',
    predicted: 'up',
    actual: null,
    correct: null,
    skipped: false,
    outcome: 'unresolved',
  };
}
