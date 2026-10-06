import type { RoundRecord } from '../types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

export function randomRounds(seed: number, n: number): RoundRecord[] {
  const r = rng(seed);
  const out: RoundRecord[] = [];
  for (let i = 0; i < n; i++) {
    const kind = r();
    const skipped = kind < 0.12;
    const unresolved = !skipped && kind < 0.18;
    const mode = pick(r, ['direction', 'bracket', undefined] as const);
    out.push({
      id: `r${seed}-${i}`,
      playedAt: 1_700_000_000_000 + i,
      symbol: pick(r, ['ES', 'NQ'] as const),
      playTf: pick(r, ['1m', '5m', '15m', '1h', '1d'] as const),
      chartTf: pick(r, ['1m', '5m', '4h'] as const),
      mode,
      predicted: skipped ? null : pick(r, ['up', 'down'] as const),
      actual: skipped ? null : pick(r, ['up', 'down'] as const),
      correct: skipped || unresolved ? null : r() < 0.52,
      skipped: skipped ? true : r() < 0.5 ? false : undefined,
      cutoff: i * 60,
      nextOpen: 1,
      nextHigh: 2,
      nextLow: 0,
      nextClose: 1,
      session: pick(r, ['asia', 'europe', 'america_rth', 'america_eth'] as const),
      dayOfWeek: Math.floor(r() * 7),
      hour: Math.floor(r() * 24),
      barRange: r(),
      rangeBucket: skipped ? null : pick(r, ['small', 'mid', 'large', null] as const),
      volBucket: pick(r, ['low', 'mid', 'high'] as const),
      streakBefore: 0,
      timeToAnswerMs: 100,
    });
  }
  return out;
}
