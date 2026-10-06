import { describe, expect, it } from 'vitest';
import * as ref from './__fixtures__/statsReference';
import { buildEquity, computeOverall, computeStats, currentStreakValue } from './stats';
import { randomRounds } from './__fixtures__/randomRounds';

describe('stats matches the reference implementation', () => {
  const sizes = [0, 1, 2, 5, 19, 20, 21, 49, 50, 51, 99, 100, 101, 257, 3000];
  for (const n of sizes) {
    for (const seed of [1, 7, 42]) {
      it(`computeStats n=${n} seed=${seed}`, () => {
        const rounds = randomRounds(seed * 1000 + n, n);
        expect(computeStats(rounds)).toEqual(ref.computeStats(rounds));
        expect(computeOverall(rounds)).toEqual(ref.computeOverall(rounds));
        expect(currentStreakValue(rounds)).toBe(ref.currentStreakValue(rounds));
        for (const w of [1, 3, 20, 500]) {
          expect(buildEquity(rounds, w)).toEqual(ref.buildEquity(rounds, w));
        }
      });
    }
  }

  it('is identical on long same-outcome runs and all-skip histories', () => {
    const base = randomRounds(9, 300);
    const allWins = base.map((r) => ({ ...r, correct: true, skipped: false }));
    const allSkips = base.map((r) => ({ ...r, correct: null, skipped: true }));
    for (const rounds of [allWins, allSkips]) {
      expect(computeStats(rounds)).toEqual(ref.computeStats(rounds));
    }
  });

  it('handles 100k rounds quickly', () => {
    const rounds = randomRounds(5, 100_000);
    const t0 = performance.now();
    const report = computeStats(rounds);
    const elapsed = performance.now() - t0;
    expect(report.overall.total).toBe(100_000);
    expect(elapsed).toBeLessThan(2000);
  });
});
