import { describe, expect, it } from 'vitest';
import { GameEngine } from './gameEngine.ts';
import { BarSeries } from './binary.ts';
import type { RoundStore, StoredRound } from './roundStore.ts';
import { defaultBracketDistance } from '../src/lib/bracket.ts';
import { BALANCED_BLOCK, isStrictlyAlternating } from '../src/lib/sampling.ts';
import type { Bar, Direction } from '../src/lib/types.ts';

const T0 = 1_700_000_000;

class MemoryRounds implements RoundStore {
  private rows = new Map<string, StoredRound & { status: 'pending' | 'revealed' }>();

  insert(round: StoredRound): void {
    this.rows.set(round.id, { ...round, status: 'pending' });
  }

  peek(id: string): StoredRound | null {
    const row = this.rows.get(id);
    return row?.status === 'pending' ? row : null;
  }

  claim(id: string): StoredRound | null {
    const row = this.rows.get(id);
    if (!row || row.status !== 'pending') return null;
    row.status = 'revealed';
    return row;
  }

  expireOlderThan(): void {}

  countPending(): number {
    let n = 0;
    for (const row of this.rows.values()) if (row.status === 'pending') n += 1;
    return n;
  }
}

function bar(i: number, o: number, h: number, l: number, c: number): Bar {
  return { t: T0 + i * 60, o, h, l, c, v: 1 };
}

function directionSeries(count: number, nextIsUp: (index: number) => boolean): BarSeries {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const up = nextIsUp(i);
    const o = 100;
    const c = up ? 101 : 99;
    bars.push(bar(i, o, Math.max(o, c), Math.min(o, c), c));
  }
  return new BarSeries(bars);
}

/** Calm 1-point bars, with a ±2.5 spike every 30 bars so 1×ATR resolves and 5×ATR does not. */
function bracketSeries(count: number): BarSeries {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const calm = bar(i, 100, 100.5, 99.5, 100);
    if (i < 230 || (i - 230) % 30 !== 0) {
      bars.push(calm);
      continue;
    }
    const up = ((i - 230) / 30) % 2 === 0;
    bars.push(up ? bar(i, 100, 102.5, 99.75, 101) : bar(i, 100, 100.25, 97.5, 99));
  }
  return new BarSeries(bars);
}

describe('balanced question draws', () => {
  it('splits direction questions evenly and does not alternate', () => {
    const engine = new GameEngine(new MemoryRounds());
    engine.setSeries('ES', '1m', directionSeries(280, (i) => i % 2 === 0));
    const actual: Direction[] = [];
    for (let i = 0; i < BALANCED_BLOCK; i++) {
      const round = engine.createRound('ES', '1m', {}, 'direction', 'user-1', {
        sampling: 'balanced',
        samplingSessionId: 'direction-session-1',
      });
      expect(round.defaultAtrMultiple).toBe(2);
      actual.push(engine.reveal(round.roundId, 'up').actual);
    }
    expect(actual.filter((side) => side === 'up')).toHaveLength(BALANCED_BLOCK / 2);
    expect(actual.filter((side) => side === 'down')).toHaveLength(BALANCED_BLOCK / 2);
    expect(actual).toEqual(engine.balancedSidesDealt('direction-session-1'));
    expect(isStrictlyAlternating(actual)).toBe(false);
  });

  it('refuses a 50/50 direction game when one side is missing', () => {
    const engine = new GameEngine(new MemoryRounds());
    engine.setSeries('ES', '1m', directionSeries(280, () => true));
    expect(() =>
      engine.createRound('ES', '1m', {}, 'direction', 'user-1', {
        sampling: 'balanced',
        samplingSessionId: 'direction-session-2',
      }),
    ).toThrow(/涨和跌/);
  });

  it('splits bracket first-touch sides at the chosen ATR multiple and uses that default', () => {
    const engine = new GameEngine(new MemoryRounds());
    const series = bracketSeries(900);
    engine.setSeries('ES', '1m', series);
    const sides: Direction[] = [];
    for (let i = 0; i < BALANCED_BLOCK; i++) {
      const round = engine.createRound('ES', '1m', {}, 'bracket', 'user-1', {
        sampling: 'balanced',
        samplingSessionId: 'bracket-session-1',
        atrMultiple: 1,
      });
      expect(round.defaultAtrMultiple).toBe(1);
      const distance = defaultBracketDistance(round.atr, round.minDistance, round.defaultAtrMultiple);
      const revealed = engine.revealBracket(round.roundId, 'up', distance);
      expect(revealed.distance).toBe(distance);
      expect(revealed.outcome === 'tp' || revealed.outcome === 'sl').toBe(true);
      sides.push(revealed.outcome === 'tp' ? 'up' : 'down');
    }
    expect(sides.filter((side) => side === 'up')).toHaveLength(BALANCED_BLOCK / 2);
    expect(sides.filter((side) => side === 'down')).toHaveLength(BALANCED_BLOCK / 2);
    expect(sides).toEqual(engine.balancedSidesDealt('bracket-session-1'));
    expect(isStrictlyAlternating(sides)).toBe(false);
  });

  it('does not treat a wide ATR multiple as a hit when price never gets there', () => {
    const engine = new GameEngine(new MemoryRounds());
    engine.setSeries('ES', '1m', bracketSeries(900));
    expect(() =>
      engine.createRound('ES', '1m', {}, 'bracket', 'user-1', {
        sampling: 'balanced',
        samplingSessionId: 'bracket-session-wide',
        atrMultiple: 5,
      }),
    ).toThrow(/ATR 倍率/);
  });

  it('keeps random bracket rounds on the 2×ATR default', () => {
    const engine = new GameEngine(new MemoryRounds());
    engine.setSeries('ES', '1m', bracketSeries(900));
    const round = engine.createRound('ES', '1m', {}, 'bracket', 'user-1', {
      sampling: 'random',
      atrMultiple: 5,
    });
    expect(round.defaultAtrMultiple).toBe(2);
  });
});
