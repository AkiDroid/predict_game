import type { Direction } from './types';

/** ES and NQ minimum price increment. */
export const PRICE_TICK = 0.25;

/** How many play-timeframe bars to scan before calling the trade unresolved. */
export const BRACKET_MAX_BARS = 500;

/** Starting take-profit / stop-loss distance for a new round, in ATR multiples. */
export const DEFAULT_BRACKET_ATR_MULTIPLE = 2;

export type TouchOutcome = 'tp' | 'sl';

export interface Bracket {
  direction: Direction;
  entry: number;
  distance: number;
  takeProfit: number;
  stopLoss: number;
}

export interface TouchHit {
  outcome: TouchOutcome;
  index: number;
  time: number;
}

/** ATR rounded up to the next tick. Exact tick multiples stay put. */
export function minBracketDistance(atr: number, tick = PRICE_TICK): number {
  if (!(atr > 0)) return tick;
  return ceilToTick(atr, tick);
}

export function ceilToTick(value: number, tick: number): number {
  const units = value / tick;
  const nearest = Math.round(units);
  if (Math.abs(units - nearest) <= 1e-6) return cleanTick(nearest * tick);
  return cleanTick(Math.ceil(units - 1e-9) * tick);
}

/** Distance is at least `minDistance`, then snapped to the nearest tick. */
export function snapDistance(raw: number, minDistance: number, tick = PRICE_TICK): number {
  const floor = Math.max(minDistance, tick);
  const clamped = Math.max(floor, raw);
  let snapped = Math.round(clamped / tick) * tick;
  if (snapped + 1e-6 < floor) snapped = floor;
  return cleanTick(snapped);
}

/** Default distance for a new round: `multiple`×ATR on the tick grid, never below `minDistance`. */
export function defaultBracketDistance(
  atr: number,
  minDistance: number,
  multiple = DEFAULT_BRACKET_ATR_MULTIPLE,
  tick = PRICE_TICK,
): number {
  if (!(atr > 0)) return snapDistance(minDistance, minDistance, tick);
  return snapDistance(ceilToTick(atr * multiple, tick), minDistance, tick);
}

export function makeBracket(entry: number, direction: Direction, distance: number): Bracket {
  const takeProfit = direction === 'up' ? entry + distance : entry - distance;
  const stopLoss = direction === 'up' ? entry - distance : entry + distance;
  return { direction, entry, distance, takeProfit, stopLoss };
}

/**
 * Drag either line. The other stays the same distance on the opposite side of entry.
 * Crossing entry flips long/short. Distance cannot shrink below `minDistance`.
 */
export function bracketFromPointer(
  entry: number,
  pointerPrice: number,
  role: 'tp' | 'sl',
  minDistance: number,
  tick = PRICE_TICK,
): Bracket {
  const above = pointerPrice >= entry;
  const direction: Direction = role === 'tp' ? (above ? 'up' : 'down') : above ? 'down' : 'up';
  const distance = snapDistance(Math.abs(pointerPrice - entry), minDistance, tick);
  return makeBracket(entry, direction, distance);
}

export function formatAtrMultiple(distance: number, atr: number): string {
  if (!(atr > 0)) return '—';
  return `${(distance / atr).toFixed(2)}×ATR`;
}

/**
 * Which level a single bar hits first.
 * Gap from the previous close to the open is checked before the intrabar path.
 * Bullish bars walk open → low → high → close; bearish bars walk open → high → low → close.
 * If both levels lie on the same segment, the closer one to the segment start wins;
 * an exact tie counts as the stop.
 */
export function resolveOhlcTouch(
  prevClose: number,
  open: number,
  high: number,
  low: number,
  close: number,
  takeProfit: number,
  stopLoss: number,
): TouchOutcome | null {
  const gap = walkSegment(prevClose, open, takeProfit, stopLoss);
  if (gap) return gap;
  if (close >= open) {
    return (
      walkSegment(open, low, takeProfit, stopLoss) ??
      walkSegment(low, high, takeProfit, stopLoss) ??
      walkSegment(high, close, takeProfit, stopLoss)
    );
  }
  return (
    walkSegment(open, high, takeProfit, stopLoss) ??
    walkSegment(high, low, takeProfit, stopLoss) ??
    walkSegment(low, close, takeProfit, stopLoss)
  );
}

/** Scan bars in order. `entry` is the previous close before the first bar. */
export function firstTouch(
  bars: Array<{ t: number; o: number; h: number; l: number; c: number }>,
  entry: number,
  takeProfit: number,
  stopLoss: number,
): TouchHit | null {
  let prev = entry;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const outcome = resolveOhlcTouch(prev, bar.o, bar.h, bar.l, bar.c, takeProfit, stopLoss);
    if (outcome) return { outcome, index: i, time: bar.t };
    prev = bar.c;
  }
  return null;
}

function walkSegment(a: number, b: number, tp: number, sl: number): TouchOutcome | null {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const tpHit = tp >= lo && tp <= hi;
  const slHit = sl >= lo && sl <= hi;
  if (tpHit && slHit) return Math.abs(tp - a) < Math.abs(sl - a) ? 'tp' : 'sl';
  if (tpHit) return 'tp';
  if (slHit) return 'sl';
  return null;
}

function cleanTick(value: number): number {
  return Math.round(value * 10000) / 10000;
}
