import type { Bar, RangeBucket, VolBucket } from './types';

/** Wilder-style ATR over last n bars ending at lastIndex (inclusive). */
export function atr(bars: Bar[], lastIndex: number, period = 14): number {
  if (lastIndex < 1 || period < 1) return 0;
  const start = Math.max(1, lastIndex - period + 1);
  let sum = 0;
  let n = 0;
  for (let i = start; i <= lastIndex; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
    sum += tr;
    n++;
  }
  return n ? sum / n : 0;
}

export function recentReturn(bars: Bar[], lastIndex: number, lookback = 20): number {
  if (lastIndex < lookback) return 0;
  const a = bars[lastIndex - lookback].c;
  const b = bars[lastIndex].c;
  if (a === 0) return 0;
  return (b - a) / a;
}

export function bodyRange(bar: Bar): number {
  return Math.abs(bar.c - bar.o);
}

/**
 * Assign volatility bucket from ATR% relative to tercile thresholds
 * computed on a sample of atrPct values (caller provides thresholds).
 */
export function volBucketFromAtrPct(
  atrPct: number,
  lowMax: number,
  midMax: number,
): VolBucket {
  if (atrPct <= lowMax) return 'low';
  if (atrPct <= midMax) return 'mid';
  return 'high';
}

/** Tercile thresholds from sorted sample. */
export function tercileThresholds(values: number[]): { lowMax: number; midMax: number } {
  if (values.length === 0) return { lowMax: 0, midMax: 0 };
  const s = values.slice().sort((a, b) => a - b);
  const i1 = Math.floor((s.length - 1) / 3);
  const i2 = Math.floor((2 * (s.length - 1)) / 3);
  return { lowMax: s[i1], midMax: s[i2] };
}

export function rangeBucketFromBody(
  body: number,
  lowMax: number,
  midMax: number,
): RangeBucket {
  if (body <= lowMax) return 'small';
  if (body <= midMax) return 'mid';
  return 'large';
}

export const VOL_LABELS: Record<VolBucket, string> = {
  low: '低波动',
  mid: '中波动',
  high: '高波动',
};

export const RANGE_LABELS: Record<RangeBucket, string> = {
  small: '小实体',
  mid: '中实体',
  large: '大实体',
};
