import { describe, expect, it } from 'vitest';
import * as ref from './__fixtures__/statsReference';
import { buildEquity, computeStats } from '../../backend/src/modules/stats/analysis';
import { computeOverall, currentStreakValue } from './stats';
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


describe('direction slices across game modes', () => {
  const base = randomRounds(1, 1)[0];
  const round = (fields: Partial<typeof base>) => ({ ...base, skipped: false, ...fields });

  it('counts long/short wins and losses even with only bracket history', () => {
    const report = computeStats([
      round({ mode: 'bracket', predicted: 'up', actual: 'up', correct: true, outcome: 'tp' }),
      round({ mode: 'bracket', predicted: 'up', actual: 'down', correct: false, outcome: 'sl' }),
      round({ mode: 'bracket', predicted: 'down', actual: 'down', correct: true, outcome: 'tp' }),
      round({ mode: 'bracket', predicted: 'down', actual: 'up', correct: false, outcome: 'sl' }),
      round({ mode: 'bracket', predicted: 'up', actual: null, correct: null, outcome: 'unresolved' }),
      round({ mode: 'bracket', predicted: null, actual: null, correct: null, skipped: true }),
    ]);
    for (const slices of [report.byPredicted, report.byActual]) {
      expect(slices).toHaveLength(2);
      for (const slice of slices) {
        expect(slice).toMatchObject({ n: 2, wins: 1, losses: 1, skips: 0, winRate: 0.5 });
      }
    }
    expect(report.overall).toMatchObject({ total: 6, answered: 4, skips: 1, unresolved: 1 });
  });

  it('includes legacy direction records and never labels absent directions as down', () => {
    const report = computeStats([
      round({ mode: undefined, predicted: 'up', actual: 'up', correct: true }),
      round({ mode: 'direction', predicted: 'down', actual: 'up', correct: false }),
      round({ mode: 'bracket', predicted: 'down', actual: 'down', correct: true }),
      round({ mode: 'bracket', predicted: null, actual: null, correct: false }),
    ]);
    expect(report.byPredicted.find((s) => s.key === 'up')).toMatchObject({ n: 1, wins: 1 });
    expect(report.byPredicted.find((s) => s.key === 'down')).toMatchObject({ n: 2, wins: 1 });
    expect(report.byActual.find((s) => s.key === 'up')).toMatchObject({ n: 2, wins: 1 });
    expect(report.byActual.find((s) => s.key === 'down')).toMatchObject({ n: 1, wins: 1 });
    expect(report.byPredicted.map((s) => s.key).sort()).toEqual(['down', 'up']);
    expect(report.byActual.map((s) => s.key).sort()).toEqual(['down', 'up']);
  });

  it('leaves both slices empty when every round is skipped or unresolved', () => {
    const report = computeStats([
      round({ mode: 'bracket', predicted: 'down', actual: null, correct: null, outcome: 'unresolved' }),
      round({ predicted: null, actual: null, correct: null, skipped: true }),
    ]);
    expect(report.byPredicted).toEqual([]);
    expect(report.byActual).toEqual([]);
  });

  it('does not score skipped rounds even when their results are revealed', () => {
    const report = computeStats([
      round({ mode: 'direction', predicted: null, actual: 'up', correct: null, skipped: true }),
      round({ mode: 'bracket', predicted: null, actual: 'down', correct: null, skipped: true, outcome: 'sl' }),
      round({ mode: 'bracket', predicted: null, actual: null, correct: null, skipped: true, outcome: 'unresolved' }),
    ]);
    expect(report.overall).toMatchObject({ total: 3, answered: 0, wins: 0, losses: 0, skips: 3, unresolved: 0 });
    expect(report.byPredicted).toEqual([]);
    expect(report.byActual).toEqual([]);
  });
});
