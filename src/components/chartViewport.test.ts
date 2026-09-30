import { describe, expect, it } from 'vitest';
import {
  anchorCenterX,
  barIndexByTime,
  chartViewportAction,
  logicalRangeForAnchor,
  pinViewportPlan,
} from './chartViewport';
import type { Bar } from '../lib/types';

function bar(t: number, price = 100): Bar {
  return { t, o: price, h: price + 1, l: price - 1, c: price, v: 1 };
}

describe('chartViewportAction', () => {
  const series = [bar(10), bar(20), bar(30)];

  it('frames the first series and any jump to a new price window', () => {
    expect(chartViewportAction(null, 0, series)).toBe('frame');
    expect(chartViewportAction(99, 3, [bar(200), bar(210), bar(220)])).toBe('frame');
  });

  it('keeps the viewport when older history is prepended or the same series is set again', () => {
    expect(chartViewportAction(30, 3, [bar(1), bar(10), bar(20), bar(30)])).toBe('keep');
    expect(chartViewportAction(30, 3, [bar(10), bar(20), bar(30)])).toBe('keep');
  });

  it('follows a revealed bar without resetting zoom', () => {
    expect(chartViewportAction(30, 3, [bar(10), bar(20), bar(30), bar(40)])).toBe('follow');
  });
});

describe('pinViewportPlan', () => {
  it('holds the decision bar when the answer extends the series', () => {
    expect(pinViewportPlan('follow')).toBe('hold');
  });

  it('rescales a new question', () => {
    expect(pinViewportPlan('frame')).toBe('rescale');
  });

  it('leaves prepended history alone', () => {
    expect(pinViewportPlan('keep')).toBe('keep');
  });
});

describe('logicalRangeForAnchor', () => {
  it('places the anchor at the requested plot x and bar spacing', () => {
    const plotWidth = 601;
    const spacing = 6;
    const anchor = 399;
    const x = 480;
    const range = logicalRangeForAnchor(anchor, x, spacing, plotWidth);
    expect(range).not.toBeNull();
    expect(anchorCenterX(anchor, range!, spacing, plotWidth)).toBeCloseTo(x, 6);
    expect(plotWidth / (range!.to - range!.from + 1)).toBeCloseTo(spacing, 6);
  });

  it('keeps the same screen x when the next question changes bar spacing', () => {
    const plotWidth = 800;
    const anchor = 120;
    const x = 610;
    const tight = logicalRangeForAnchor(anchor, x, 14, plotWidth)!;
    const wide = logicalRangeForAnchor(anchor, x, 6, plotWidth)!;
    expect(anchorCenterX(anchor, tight, 14, plotWidth)).toBeCloseTo(x, 6);
    expect(anchorCenterX(anchor, wide, 6, plotWidth)).toBeCloseTo(x, 6);
    expect(wide.to - wide.from).toBeGreaterThan(tight.to - tight.from);
  });

  it('anchors the decision bar, not bars appended after it', () => {
    const bars = [bar(10), bar(20), bar(30), bar(40), bar(50)];
    expect(barIndexByTime(bars, 30)).toBe(2);
    expect(barIndexByTime(bars, 50)).toBe(4);
    expect(barIndexByTime(bars, 15)).toBe(-1);
  });
});
