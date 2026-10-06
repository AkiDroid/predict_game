import { describe, expect, it } from 'vitest';
import { mergeBars } from './mergeBars';
import type { Bar } from './types';

const bar = (t: number, tag = 0): Bar => ({ t, o: tag, h: tag, l: tag, c: tag, v: tag });
const bars = (ts: number[], tag = 0) => ts.map((t) => bar(t, tag));

function reference(base: Bar[], winner: Bar[]): Bar[] {
  if (!base.length) return winner;
  if (!winner.length) return base;
  const map = new Map<number, Bar>();
  for (const b of base) map.set(b.t, b);
  for (const b of winner) map.set(b.t, b);
  return [...map.values()].sort((a, b) => a.t - b.t);
}

describe('mergeBars', () => {
  it('returns the other side as is when one is empty', () => {
    const a = bars([1, 2]);
    expect(mergeBars([], a)).toBe(a);
    expect(mergeBars(a, [])).toBe(a);
  });

  it('concatenates a strictly older prefix', () => {
    const older = bars([1, 2, 3], 1);
    const prev = bars([4, 5], 2);
    const out = mergeBars(older, prev);
    expect(out.map((b) => b.t)).toEqual([1, 2, 3, 4, 5]);
    expect(out[0]).toBe(older[0]);
    expect(out[3]).toBe(prev[0]);
  });

  it('concatenates a strictly newer suffix', () => {
    const prev = bars([1, 2], 1);
    const next = bars([3, 4], 2);
    expect(mergeBars(prev, next)).toEqual([...prev, ...next]);
    expect(mergeBars(next, prev)).toEqual([...prev, ...next]);
  });

  it('lets the second argument win on equal open time', () => {
    const base = bars([1, 2, 3, 5], 1);
    const winner = bars([2, 3, 4, 6], 2);
    const out = mergeBars(base, winner);
    expect(out.map((b) => [b.t, b.o])).toEqual([
      [1, 1],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 1],
      [6, 2],
    ]);
    expect(out).toEqual(reference(base, winner));
  });

  it('treats a single shared boundary bar as overlap', () => {
    const base = bars([1, 2, 3], 1);
    const winner = bars([3, 4], 2);
    const out = mergeBars(base, winner);
    expect(out.map((b) => [b.t, b.o])).toEqual([
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
    ]);
  });

  it('falls back to sort-and-dedupe for unsorted or duplicated input', () => {
    const base = bars([3, 1, 2, 2], 1);
    const winner = bars([5, 4, 4], 2);
    expect(mergeBars(base, winner)).toEqual(reference(base, winner));
  });

  it('matches the map-and-sort reference on random sorted windows', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const window = (tag: number) => {
      const start = Math.floor(rnd() * 50);
      const len = Math.floor(rnd() * 30);
      const ts: number[] = [];
      for (let t = start; ts.length < len; t += 1 + Math.floor(rnd() * 3)) ts.push(t);
      return bars(ts, tag);
    };
    for (let i = 0; i < 500; i++) {
      const a = window(1);
      const b = window(2);
      expect(mergeBars(a, b)).toEqual(reference(a, b));
    }
  });
});
