import type { RoundRecord } from './types';
import type { OverallStats } from './statsTypes';

export function isSkipped(round: RoundRecord): boolean {
  return round.skipped === true;
}

/** A settled win or loss. Skips and unresolved brackets are not scored. */
export function isScored(round: RoundRecord): boolean {
  return round.correct === true || round.correct === false;
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
