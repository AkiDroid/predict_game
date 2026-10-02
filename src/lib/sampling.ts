import { DEFAULT_BRACKET_ATR_MULTIPLE } from './bracket';
import type { Direction } from './types';

/** Choices shown before a balanced bracket game. Minimum is 1 because distance cannot be tighter. */
export const ATR_MULTIPLE_CHOICES = [1, 1.5, 2, 2.5, 3, 4, 5] as const;

export const MIN_ATR_MULTIPLE = 1;
export const MAX_ATR_MULTIPLE = 8;

/**
 * Questions per balanced block. Each block is exactly half up and half down,
 * then shuffled. A short alternating pattern is rejected so the sequence is not
 * up, down, up, down. Runs that show up in a real shuffle are kept.
 */
export const BALANCED_BLOCK = 20;

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

export function balancedBlock(random: () => number = Math.random, size = BALANCED_BLOCK): Direction[] {
  if (size < 2 || size % 2 !== 0) throw new Error('balanced block size must be even');
  const half = size / 2;
  const block: Direction[] = [
    ...Array.from({ length: half }, () => 'up' as const),
    ...Array.from({ length: half }, () => 'down' as const),
  ];
  for (let attempt = 0; attempt < 8; attempt++) {
    shuffleInPlace(block, random);
    if (!isStrictlyAlternating(block)) return block.slice();
  }
  return block.slice();
}

export function isStrictlyAlternating(sides: readonly Direction[]): boolean {
  if (sides.length < 2) return false;
  for (let i = 1; i < sides.length; i++) {
    if (sides[i] === sides[i - 1]) return false;
  }
  return true;
}

/** Session queue: exact 50/50 inside each block, served in shuffled order. */
export class SideDeck {
  private queue: Direction[] = [];
  private readonly used = new Set<number>();
  readonly served: Direction[] = [];
  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  private ensure(): void {
    if (this.queue.length > 0) return;
    this.queue = balancedBlock(this.random);
  }

  peek(): Direction {
    this.ensure();
    return this.queue[this.queue.length - 1]!;
  }

  commit(): void {
    this.ensure();
    const side = this.queue.pop();
    if (!side) throw new Error('出题队列为空');
    this.served.push(side);
  }

  hasUsed(index: number): boolean {
    return this.used.has(index);
  }

  markUsed(index: number): void {
    this.used.add(index);
  }
}

/** Prefer an index that has not been dealt in this session. Null when every index was used. */
export function pickFresh(
  pool: readonly number[],
  isUsed: (index: number) => boolean,
  random: () => number = Math.random,
): number | null {
  if (pool.length === 0) return null;
  for (let n = 0; n < 32; n++) {
    const index = pool[Math.floor(random() * pool.length)]!;
    if (!isUsed(index)) return index;
  }
  const fresh = pool.filter((index) => !isUsed(index));
  if (fresh.length === 0) return null;
  return fresh[Math.floor(random() * fresh.length)]!;
}

function shuffleInPlace<T>(items: T[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
}
