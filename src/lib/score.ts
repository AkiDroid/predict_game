import type { Bar, Direction } from './types';

/** Primary rule: 涨 = close > open. Doji (close === open) has no direction. */
export function barDirection(bar: Bar): Direction | null {
  if (bar.c > bar.o) return 'up';
  if (bar.c < bar.o) return 'down';
  return null;
}

export function isDoji(bar: Bar): boolean {
  return bar.c === bar.o;
}

export function isWin(predicted: Direction, actual: Direction): boolean {
  return predicted === actual;
}

export function scoreRound(predicted: Direction, nextBar: Bar): {
  actual: Direction | null;
  correct: boolean | null;
} {
  const actual = barDirection(nextBar);
  if (actual === null) return { actual: null, correct: null };
  return { actual, correct: isWin(predicted, actual) };
}
