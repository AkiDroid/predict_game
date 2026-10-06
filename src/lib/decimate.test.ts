import { describe, expect, it } from 'vitest';
import { decimatedIndices } from './decimate';

describe('decimatedIndices', () => {
  it('keeps every point when the series fits the width', () => {
    expect(decimatedIndices(10, 100, (i) => i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(decimatedIndices(0, 100, (i) => i)).toEqual([]);
  });

  it('keeps first, last and the per-bucket extremes in index order', () => {
    let s = 3;
    const values = Array.from({ length: 100_000 }, () => {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      return (s % 2001) - 1000;
    });
    const cols = 300;
    const idx = decimatedIndices(values.length, cols, (i) => values[i]);
    expect(idx.length).toBeLessThanOrEqual(cols * 4);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(values.length - 1);
    for (let k = 1; k < idx.length; k++) expect(idx[k]).toBeGreaterThan(idx[k - 1]);
    const kept = idx.map((i) => values[i]);
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(Math.min(...kept)).toBe(min);
    expect(Math.max(...kept)).toBe(max);
  });
});
