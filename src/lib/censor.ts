import type { Bar, Timeframe } from './types';
import { barEndUnix } from './resample';

/**
 * Censor chart bars so nothing after cutoff T is visible.
 * T = open time of the play-timeframe bar being predicted.
 * A bar is visible iff its period fully ends at or before T (barEnd <= T).
 */
export function censorBars(bars: Bar[], tf: Timeframe, cutoffExclusive: number): Bar[] {
  if (bars.length === 0) return bars;
  // Binary search last visible
  let lo = 0;
  let hi = bars.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (barEndUnix(bars[mid].t, tf) <= cutoffExclusive) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return last < 0 ? [] : bars.slice(0, last + 1);
}

/** Max timestamp (open) still allowed on this TF under cutoff T. */
export function maxVisibleOpen(tf: Timeframe, cutoffExclusive: number, probeBars: Bar[]): number | null {
  const censored = censorBars(probeBars, tf, cutoffExclusive);
  if (censored.length === 0) return null;
  return censored[censored.length - 1].t;
}

export function assertNoLeakage(bars: Bar[], tf: Timeframe, cutoffExclusive: number): boolean {
  return bars.every((b) => barEndUnix(b.t, tf) <= cutoffExclusive);
}
