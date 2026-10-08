export type SymbolId = 'ES' | 'NQ';

export type Timeframe =
  | '1m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '4h'
  | '1d';

export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  '1m': '1分钟',
  '5m': '5分钟',
  '15m': '15分钟',
  '30m': '30分钟',
  '1h': '1小时',
  '4h': '4小时',
  '1d': '日线',
};

export const SYMBOL_META: Record<
  SymbolId,
  { id: SymbolId; name: string; fullName: string }
> = {
  ES: { id: 'ES', name: 'ES', fullName: '标普500 E-mini' },
  NQ: { id: 'NQ', name: 'NQ', fullName: '纳斯达克100 E-mini' },
};

/** Bar open time as Unix seconds (UTC). */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Direction = 'up' | 'down';

/** direction: next-bar up/down. bracket: 1:1 take-profit / stop-loss, first touch wins. */
export type PlayMode = 'direction' | 'bracket';

export type BracketOutcome = 'tp' | 'sl' | 'unresolved';

export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  direction: '下一根方向',
  bracket: '止盈止损',
};

/** random: uniform draw. balanced: coin-flip a side, then redraw until it matches. */
export type SamplingMode = 'random' | 'balanced';

export const SAMPLING_LABELS: Record<SamplingMode, string> = {
  random: '随机出题',
  balanced: '涨跌各 50%',
};

export type SessionBucket = 'asia' | 'europe' | 'america_rth' | 'america_eth';

export type VolBucket = 'low' | 'mid' | 'high';
export type RangeBucket = 'small' | 'mid' | 'large';

export interface RoundRecord {
  id: string;
  playedAt: number;
  symbol: SymbolId;
  playTf: Timeframe;
  chartTf: Timeframe;
  /** Absent on records saved before bracket mode existed; those are direction rounds. */
  mode?: PlayMode;
  /** Null when the round was skipped. */
  predicted: Direction | null;
  /** Null on older skipped records or when a bracket round remains unresolved. */
  actual: Direction | null;
  /** Null when the round was skipped. */
  correct: boolean | null;
  /** True when the player skipped this question. Absent on older records. */
  skipped?: boolean;
  cutoff: number;
  nextOpen: number;
  nextHigh: number;
  nextLow: number;
  nextClose: number;
  session: SessionBucket;
  dayOfWeek: number;
  hour: number;
  barRange: number;
  /** Null for bracket rounds and older skipped records. */
  rangeBucket: RangeBucket | null;
  volBucket: VolBucket;
  streakBefore: number;
  timeToAnswerMs: number;
  /** Bracket rounds only. */
  entry?: number;
  takeProfit?: number;
  stopLoss?: number;
  distance?: number;
  atr?: number;
  outcome?: BracketOutcome;
  /** Play-timeframe bars from the first bar after entry through the touch, inclusive. */
  barsToHit?: number | null;
}

export interface GameFilters {
  dateFrom?: number;
  dateTo?: number;
  sessions?: SessionBucket[];
}

export interface RoundContext {
  roundId: string;
  symbol: SymbolId;
  playTf: Timeframe;
  cutoff: number;
  lastBar: Bar;
  atr: number;
  atrPct: number;
  recentReturn: number;
  volBucket: VolBucket;
  session: SessionBucket;
  hour: number;
  dayOfWeek: number;
  /** Minimum 1:1 distance: ATR(14) rounded up to the contract tick. */
  minDistance: number;
  /**
   * ATR multiple used as the initial bracket distance.
   * Balanced bracket rounds use the multiple chosen before the game; other rounds stay at 2.
   */
  defaultAtrMultiple: number;
}

export interface BracketReveal {
  outcome: BracketOutcome;
  correct: boolean | null;
  direction: Direction;
  predicted: Direction;
  actual: Direction | null;
  entry: number;
  takeProfit: number;
  stopLoss: number;
  distance: number;
  atr: number;
  barsToHit: number | null;
  hitTime: number | null;
  revealUntil: number;
  hitBar: Bar | null;
  meta: {
    session: SessionBucket;
    hour: number;
    dayOfWeek: number;
    barRange: number;
    rangeBucket: null;
    volBucket: VolBucket;
    cutoff: number;
    nextBarEnd: number;
    symbol: SymbolId;
    playTf: Timeframe;
  };
}

export interface RevealResult {
  nextBar: Bar;
  actual: Direction;
  correct: boolean;
  predicted: Direction;
}
