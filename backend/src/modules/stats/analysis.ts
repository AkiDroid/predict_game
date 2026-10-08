import type {
  Direction,
  PlayMode,
  RangeBucket,
  RoundRecord,
  SessionBucket,
  SymbolId,
  Timeframe,
  VolBucket,
} from '../../../../src/lib/types.ts';

import type { OverallStats, SliceStat, StatsReport } from '../../../../src/lib/statsTypes.ts';

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
  let skips = 0;
  let n = 0;
  let wins = 0;
  for (const r of rounds) {
    if (isSkipped(r)) skips++;
    if (isScored(r)) {
      n++;
      if (r.correct) wins++;
    }
  }
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

/** Win rate over the last `windows[k]` scored rounds (all of them if fewer), from one backward scan. */
function recentWinRates(rounds: RoundRecord[], windows: number[]): (number | null)[] {
  const largest = Math.max(...windows);
  const winsAt = new Map<number, number>();
  let seen = 0;
  let wins = 0;
  for (let i = rounds.length - 1; i >= 0 && seen < largest; i--) {
    const r = rounds[i];
    if (!isScored(r)) continue;
    seen++;
    if (r.correct) wins++;
    if (windows.includes(seen)) winsAt.set(seen, wins);
  }
  return windows.map((n) => {
    if (seen === 0) return null;
    const len = Math.min(n, seen);
    return (winsAt.get(len) ?? wins) / len;
  });
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
  const [recent20, recent50, recent100] = recentWinRates(rounds, [20, 50, 100]);
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
    recent20,
    recent50,
    recent100,
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
  return equityOfScored(rounds.filter((r) => isScored(r)), window);
}

function equityOfScored(answered: RoundRecord[], window: number): StatsReport['equity'] {
  let eq = 0;
  let windowWins = 0;
  const out: StatsReport['equity'] = new Array(answered.length);
  for (let i = 0; i < answered.length; i++) {
    const win = answered[i].correct;
    eq += win ? 1 : -1;
    if (win) windowWins++;
    const from = i - window + 1;
    if (from > 0 && answered[from - 1].correct) windowWins--;
    const len = from > 0 ? window : i + 1;
    out[i] = { i: i + 1, equity: eq, rolling: windowWins / len };
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
  const byPredicted = groupBy(
    scored.filter((r) => r.predicted === 'up' || r.predicted === 'down'),
    (r) => r.predicted as Direction,
    (k) => (k === 'up' ? '猜涨 / 做多' : '猜跌 / 做空'),
  );
  const byActual = groupBy(
    scored.filter((r) => r.actual === 'up' || r.actual === 'down'),
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
    equity: equityOfScored(scored, 20),
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
