import { DEFAULT_BRACKET_ATR_MULTIPLE } from './bracket';
import type { Direction } from './types';

/** Choices shown before a balanced bracket game. Minimum is 1 because distance cannot be tighter. */
export const ATR_MULTIPLE_CHOICES = [1, 1.5, 2, 2.5, 3, 4, 5] as const;

export const MIN_ATR_MULTIPLE = 1;
export const MAX_ATR_MULTIPLE = 8;

/** How many random draws to try before keeping the last one. */
export const BALANCED_DRAW_LIMIT = 15;

export function isAtrMultipleChoice(value: number): boolean {
  return ATR_MULTIPLE_CHOICES.some((choice) => choice === value);
}

export function normalizeAtrMultiple(value: number | undefined): number {
  const n = value == null ? DEFAULT_BRACKET_ATR_MULTIPLE : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('ATR 倍率无效');
  const rounded = Math.round(n * 100) / 100;
  if (rounded < MIN_ATR_MULTIPLE || rounded > MAX_ATR_MULTIPLE) {
    throw new Error(`ATR 倍率需要在 ${MIN_ATR_MULTIPLE} 到 ${MAX_ATR_MULTIPLE} 之间`);
  }
  return rounded;
}

/**
 * Flip a coin for the target side, then draw until the item matches.
 * After `limit` mismatches, keep the last draw.
 */
export function pickBalancedDraw<T>(
  random: () => number,
  draw: () => T,
  sideOf: (item: T) => Direction | null,
  limit = BALANCED_DRAW_LIMIT,
): T {
  if (limit < 1) throw new Error('draw limit must be at least 1');
  const wanted: Direction = random() < 0.5 ? 'up' : 'down';
  let last!: T;
  for (let n = 0; n < limit; n++) {
    last = draw();
    if (sideOf(last) === wanted) return last;
  }
  return last;
}
