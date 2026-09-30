import type { Bar } from '../lib/types';

export type ViewportAction = 'keep' | 'follow' | 'frame';

/**
 * How to place the viewport after a data update.
 * - keep: older history was prepended; leave zoom and pan alone
 * - follow: the series continued (answer reveal); scroll the new bar in, keep zoom
 * - frame: a new price window (next question); reset zoom and fit that price
 */
export function chartViewportAction(
  prevLast: number | null,
  _prevLen: number,
  bars: Bar[],
): ViewportAction {
  if (!bars.length) return 'keep';
  const last = bars[bars.length - 1].t;
  // Same right edge: prepended history, or the same window set again.
  if (prevLast === last) return 'keep';
  if (prevLast !== null && containsTime(bars, prevLast)) return 'follow';
  return 'frame';
}

/**
 * Bracket mode keeps the decision bar glued to the screen.
 * - hold: answer bars were appended; do not scroll or rescale around them
 * - rescale: a new question; fit price and the standard bar spacing, but keep the right edge
 * - keep: older history was prepended
 */
export type PinnedViewportPlan = 'keep' | 'hold' | 'rescale';

export function pinViewportPlan(action: ViewportAction): PinnedViewportPlan {
  if (action === 'keep') return 'keep';
  if (action === 'follow') return 'hold';
  return 'rescale';
}

/** Index of `time` in ascending bars, or -1. */
export function barIndexByTime(bars: Bar[], time: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = bars[mid].t;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export interface LogicalRange {
  from: number;
  to: number;
}

/**
 * Logical range that puts `anchorIndex` at `xPx` (plot coordinates) using `barSpacing`.
 *
 * Matches lightweight-charts `indexToCoordinate`:
 * x = plotWidth - (deltaFromRight + 0.5) * barSpacing - 1
 * and `setVisibleLogicalRange`, which sets barSpacing = plotWidth / (to - from + 1).
 */
export function logicalRangeForAnchor(
  anchorIndex: number,
  xPx: number,
  barSpacing: number,
  plotWidth: number,
): LogicalRange | null {
  if (!(barSpacing > 0) || !(plotWidth > 0) || !Number.isFinite(anchorIndex) || !Number.isFinite(xPx)) {
    return null;
  }
  const deltaFromRight = (plotWidth - 1 - xPx) / barSpacing - 0.5;
  const count = plotWidth / barSpacing;
  const to = anchorIndex + deltaFromRight;
  const from = to - count + 1;
  if (!(from <= to)) return null;
  return { from, to };
}

/** Bar-center x implied by a logical range, using the same formula as lightweight-charts. */
export function anchorCenterX(anchorIndex: number, range: LogicalRange, barSpacing: number, plotWidth: number): number {
  const deltaFromRight = range.to - anchorIndex;
  return plotWidth - (deltaFromRight + 0.5) * barSpacing - 1;
}

/** Whether `time` is one of the bar open times. Bars are sorted ascending. */
function containsTime(bars: Bar[], time: number): boolean {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = bars[mid].t;
    if (t === time) return true;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}
