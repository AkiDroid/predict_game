import { describe, expect, it } from 'vitest';
import {
  ATR_MULTIPLE_CHOICES,
  BALANCED_BLOCK,
  balancedBlock,
  isStrictlyAlternating,
  normalizeAtrMultiple,
  pickFresh,
  SideDeck,
} from './sampling';
import type { Direction } from './types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('balanced blocks', () => {
  it('deals an even split in shuffled order', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const block = balancedBlock(mulberry32(seed));
      expect(block).toHaveLength(BALANCED_BLOCK);
      expect(block.filter((side) => side === 'up')).toHaveLength(BALANCED_BLOCK / 2);
      expect(block.filter((side) => side === 'down')).toHaveLength(BALANCED_BLOCK / 2);
      expect(isStrictlyAlternating(block)).toBe(false);
    }
  });

  it('keeps the split across successive blocks', () => {
    const deck = new SideDeck(mulberry32(7));
    const served: Direction[] = [];
    for (let i = 0; i < BALANCED_BLOCK * 2; i++) {
      expect(deck.peek()).toBeTypeOf('string');
      deck.commit();
      served.push(deck.served[i]!);
    }
    for (const start of [0, BALANCED_BLOCK]) {
      const slice = served.slice(start, start + BALANCED_BLOCK);
      expect(slice.filter((side) => side === 'up')).toHaveLength(BALANCED_BLOCK / 2);
    }
    expect(isStrictlyAlternating(served.slice(0, BALANCED_BLOCK))).toBe(false);
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

describe('pickFresh', () => {
  it('skips indices already dealt', () => {
    const used = new Set([0, 1]);
    const picks = new Set<number>();
    const random = mulberry32(3);
    for (let i = 0; i < 20; i++) {
      const picked = pickFresh([0, 1, 2, 3], (index) => used.has(index), random);
      expect(picked === 2 || picked === 3).toBe(true);
      if (picked != null) picks.add(picked);
    }
    expect(picks.size).toBeGreaterThan(0);
  });
});
