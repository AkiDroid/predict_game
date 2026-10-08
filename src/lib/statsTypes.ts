import type { PlayMode, RoundRecord, SymbolId, Timeframe } from './types';

export interface SliceStat {
  key: string;
  label: string;
  /** Answered rounds only. Skips are counted separately and excluded from win rate. */
  n: number;
  skips: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Approximate Wilson 95% lower/upper, only meaningful when computed. */
  wilsonLow?: number;
  wilsonHigh?: number;
  insufficient: boolean;
}

export interface OverallStats {
  /** All stored rounds, including skips. */
  total: number;
  /** Rounds the player actually answered. */
  answered: number;
  wins: number;
  losses: number;
  skips: number;
  /** skips / total. */
  skipRate: number;
  /** Bracket rounds that never touched either level. Excluded from win rate and streaks. */
  unresolved: number;
  /** wins / answered. Skips and unresolved rounds are excluded. */
  winRate: number;
  currentStreak: number;
  currentStreakType: 'win' | 'loss' | 'none';
  maxWinStreak: number;
  maxLossStreak: number;
  recent20: number | null;
  recent50: number | null;
  recent100: number | null;
}

export interface StatsReport {
  overall: OverallStats;
  byMode: SliceStat[];
  bySymbol: SliceStat[];
  byPlayTf: SliceStat[];
  byChartTf: SliceStat[];
  byHour: SliceStat[];
  bySession: SliceStat[];
  byDow: SliceStat[];
  byPredicted: SliceStat[];
  byActual: SliceStat[];
  byVol: SliceStat[];
  byRange: SliceStat[];
  equity: { i: number; equity: number; rolling: number }[];
  reading: string[];
}

export interface RecentRoundsFilters {
  symbol?: SymbolId;
  playTf?: Timeframe;
  mode?: PlayMode;
}

export interface RecentRoundsResponse {
  rounds: RoundRecord[];
}
