import { describe, expect, it } from 'vitest';
import { ATR_MULTIPLE_CHOICES, BALANCED_DRAW_LIMIT, normalizeAtrMultiple, pickBalancedDraw } from './sampling';
import type { Direction } from './types';

describe('pickBalancedDraw', () => {
  it('keeps the first draw that matches the coin flip', () => {
    let draws = 0;
    const sequence: Direction[] = ['down', 'up'];
    const picked = pickBalancedDraw(
      () => 0.2,
      () => sequence[draws++]!,
      (item) => item,
    );
    expect(picked).toBe('up');
    expect(draws).toBe(2);
  });

  it('returns the 15th draw when none match', () => {
    let draws = 0;
    const picked = pickBalancedDraw(
      () => 0.2,
      () => {
        draws += 1;
        return 'down' as const;
      },
      (item) => item,
    );
    expect(picked).toBe('down');
    expect(draws).toBe(BALANCED_DRAW_LIMIT);
  });

  it('treats a random value below one half as up', () => {
    let draws = 0;
    const picked = pickBalancedDraw(
      () => 0.49,
      () => {
        draws += 1;
        return 'up' as const;
      },
      (item) => item,
    );
    expect(picked).toBe('up');
    expect(draws).toBe(1);
  });
});

describe('normalizeAtrMultiple', () => {
  it('defaults to 2 and accepts the setup choices', () => {
    expect(normalizeAtrMultiple(undefined)).toBe(2);
    for (const choice of ATR_MULTIPLE_CHOICES) expect(normalizeAtrMultiple(choice)).toBe(choice);
  });

  it('rejects a multiple tighter than 1 ATR or above 8', () => {
    expect(() => normalizeAtrMultiple(0.5)).toThrow(/1 到 8/);
    expect(() => normalizeAtrMultiple(9)).toThrow(/1 到 8/);
    expect(() => normalizeAtrMultiple(Number.NaN)).toThrow(/无效/);
  });
});
