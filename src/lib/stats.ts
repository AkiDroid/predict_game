import type {
  Direction,
  PlayMode,
  RangeBucket,
  RoundRecord,
  SessionBucket,
  SymbolId,
  Timeframe,
  VolBucket,
} from './types';

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

const MIN_SAMPLE = 30;

export function isSkipped(round: RoundRecord): boolean {
  return round.skipped === true;
}

/** A settled win or loss. Skips and unresolved brackets are not scored. */
export function isScored(round: RoundRecord): boolean {
  return round.correct === true || round.correct === false;
}

function wilsonInterval(wins: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}

function sliceOf(
  key: string,
  label: string,
  rounds: RoundRecord[],
): SliceStat {
  const skips = rounds.filter((r) => isSkipped(r)).length;
  const answered = rounds.filter((r) => isScored(r));
  const n = answered.length;
  const wins = answered.filter((r) => r.correct).length;
  const losses = n - wins;
  const winRate = n ? wins / n : 0;
  const insufficient = n < MIN_SAMPLE;
  const w = wilsonInterval(wins, n);
  return {
    key,
    label,
    n,
    skips,
    wins,
    losses,
    winRate,
    wilsonLow: w.low,
    wilsonHigh: w.high,
    insufficient,
  };
}

function groupBy<T extends string | number>(
  rounds: RoundRecord[],
  keyFn: (r: RoundRecord) => T,
  labelFn: (k: T) => string,
): SliceStat[] {
  const map = new Map<T, RoundRecord[]>();
  for (const r of rounds) {
    const k = keyFn(r);
    let arr = map.get(k);
    if (!arr) {
      arr = [];
      map.set(k, arr);
    }
    arr.push(r);
  }
  return [...map.entries()]
    .map(([k, arr]) => sliceOf(String(k), labelFn(k), arr))
    .sort((a, b) => b.n + b.skips - (a.n + a.skips));
}

function recentWinRate(rounds: RoundRecord[], n: number): number | null {
  const answered = rounds.filter((r) => isScored(r));
  if (answered.length === 0) return null;
  const slice = answered.slice(-n);
  return slice.filter((r) => r.correct).length / slice.length;
}

export function computeOverall(rounds: RoundRecord[]): OverallStats {
  let wins = 0;
  let losses = 0;
  let skips = 0;
  let unresolved = 0;
  let maxWin = 0;
  let maxLoss = 0;
  let cur = 0;
  let curType: 'win' | 'loss' | 'none' = 'none';
  let run = 0;
  let runType: 'win' | 'loss' | 'none' = 'none';

  for (const r of rounds) {
    if (!isScored(r)) {
      if (isSkipped(r)) skips++;
      else unresolved++;
      continue;
    }
    if (r.correct) wins++;
    else losses++;
    const t: 'win' | 'loss' = r.correct ? 'win' : 'loss';
    if (t === runType) run++;
    else {
      runType = t;
      run = 1;
    }
    if (runType === 'win') maxWin = Math.max(maxWin, run);
    else maxLoss = Math.max(maxLoss, run);
    cur = run;
    curType = runType;
  }

  const answered = wins + losses;
  return {
    total: rounds.length,
    answered,
    wins,
    losses,
    skips,
    skipRate: rounds.length ? skips / rounds.length : 0,
    unresolved,
    winRate: answered ? wins / answered : 0,
    currentStreak: answered ? cur : 0,
    currentStreakType: answered ? curType : 'none',
    maxWinStreak: maxWin,
    maxLossStreak: maxLoss,
    recent20: recentWinRate(rounds, 20),
    recent50: recentWinRate(rounds, 50),
    recent100: recentWinRate(rounds, 100),
  };
}

const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const TF_LABEL: Record<string, string> = {
  '1m': '1分钟',
  '5m': '5分钟',
  '15m': '15分钟',
  '30m': '30分钟',
  '1h': '1小时',
  '4h': '4小时',
  '1d': '日线',
};
const SESSION_LABEL: Record<SessionBucket, string> = {
  asia: '亚洲时段',
  europe: '欧洲时段',
  america_rth: '美洲RTH',
  america_eth: '美洲ETH',
};
const VOL_LABEL: Record<VolBucket, string> = {
  low: '低波动',
  mid: '中波动',
  high: '高波动',
};
const RANGE_LABEL: Record<RangeBucket, string> = {
  small: '小实体',
  mid: '中实体',
  large: '大实体',
};

export function buildEquity(rounds: RoundRecord[], window = 20): StatsReport['equity'] {
  const answered = rounds.filter((r) => isScored(r));
  let eq = 0;
  const out: StatsReport['equity'] = [];
  for (let i = 0; i < answered.length; i++) {
    eq += answered[i].correct ? 1 : -1;
    const from = Math.max(0, i - window + 1);
    const slice = answered.slice(from, i + 1);
    const rolling = slice.filter((r) => r.correct).length / slice.length;
    out.push({ i: i + 1, equity: eq, rolling });
  }
  return out;
}

export function computeStats(rounds: RoundRecord[]): StatsReport {
  const overall = computeOverall(rounds);
  const byMode = groupBy(
    rounds,
    (r) => (r.mode ?? 'direction') as PlayMode,
    (k) => (k === 'bracket' ? '止盈止损' : '下一根方向'),
  );
  const bySymbol = groupBy(rounds, (r) => r.symbol as SymbolId, (k) => String(k));
  const byPlayTf = groupBy(rounds, (r) => r.playTf as Timeframe, (k) => TF_LABEL[k] ?? k);
  const byChartTf = groupBy(rounds, (r) => r.chartTf as Timeframe, (k) => TF_LABEL[k] ?? k);
  const byHour = groupBy(
    rounds,
    (r) => r.hour,
    (k) => `${String(k).padStart(2, '0')}:00`,
  ).sort((a, b) => Number(a.key) - Number(b.key));
  const bySession = groupBy(
    rounds,
    (r) => r.session as SessionBucket,
    (k) => SESSION_LABEL[k],
  );
  const byDow = groupBy(rounds, (r) => r.dayOfWeek, (k) => DOW[Number(k)] ?? String(k)).sort(
    (a, b) => Number(a.key) - Number(b.key),
  );
  const scored = rounds.filter((r) => isScored(r));
  const directionScored = scored.filter((r) => (r.mode ?? 'direction') === 'direction');
  const byPredicted = groupBy(
    directionScored,
    (r) => r.predicted as Direction,
    (k) => (k === 'up' ? '猜涨' : '猜跌'),
  );
  const byActual = groupBy(
    directionScored,
    (r) => r.actual as Direction,
    (k) => (k === 'up' ? '实际上涨局' : '实际下跌局'),
  );
  const byVol = groupBy(rounds, (r) => r.volBucket as VolBucket, (k) => VOL_LABEL[k]);
  const byRange = groupBy(
    scored.filter((r) => r.rangeBucket != null),
    (r) => r.rangeBucket as RangeBucket,
    (k) => RANGE_LABEL[k],
  );

  const reading = buildReading([
    ...byMode,
    ...bySymbol,
    ...byPlayTf,
    ...byChartTf,
    ...bySession,
    ...byPredicted,
    ...byVol,
  ]);

  return {
    overall,
    byMode,
    bySymbol,
    byPlayTf,
    byChartTf,
    byHour,
    bySession,
    byDow,
    byPredicted,
    byActual,
    byVol,
    byRange,
    equity: buildEquity(rounds),
    reading,
  };
}

function buildReading(slices: SliceStat[]): string[] {
  const ok = slices.filter((s) => !s.insufficient && s.n >= MIN_SAMPLE);
  if (ok.length === 0) {
    return ['样本不足：多数分片局数 < 30，暂不做强弱读数。继续作答以积累统计。'];
  }
  const sorted = [...ok].sort((a, b) => b.winRate - a.winRate);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const lines = [
    `最强分片：${best.label}（n=${best.n}，胜率 ${(best.winRate * 100).toFixed(1)}%，近似95% Wilson区间 [${((best.wilsonLow ?? 0) * 100).toFixed(1)}%, ${((best.wilsonHigh ?? 0) * 100).toFixed(1)}%]）`,
    `最弱分片：${worst.label}（n=${worst.n}，胜率 ${(worst.winRate * 100).toFixed(1)}%，近似95% Wilson区间 [${((worst.wilsonLow ?? 0) * 100).toFixed(1)}%, ${((worst.wilsonHigh ?? 0) * 100).toFixed(1)}%]）`,
  ];
  const thin = slices.filter((s) => s.insufficient && s.n > 0).length;
  if (thin > 0) lines.push(`另有 ${thin} 个分片标记为样本不足（n<30）。`);
  return lines;
}

export function currentStreakValue(rounds: RoundRecord[]): number {
  // Positive = win streak, negative = loss streak.
  // Skips and unresolved brackets do not break or extend it.
  let i = rounds.length - 1;
  while (i >= 0 && !isScored(rounds[i])) i--;
  if (i < 0) return 0;
  const last = rounds[i].correct === true;
  let s = 0;
  for (; i >= 0; i--) {
    if (!isScored(rounds[i])) continue;
    if ((rounds[i].correct === true) === last) s++;
    else break;
  }
  return last ? s : -s;
}
