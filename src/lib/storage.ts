import type { PlayMode, RoundRecord } from './types';
import { currentStreakValue } from './stats';

const KEY = 'predict_game_rounds_v1';

export function loadRounds(): RoundRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RoundRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRounds(rounds: RoundRecord[]): void {
  localStorage.setItem(KEY, JSON.stringify(rounds));
}

export function appendRound(round: RoundRecord): RoundRecord[] {
  const rounds = loadRounds();
  rounds.push(round);
  saveRounds(rounds);
  return rounds;
}

export function clearRounds(): void {
  localStorage.removeItem(KEY);
}

export function getStreakBeforeNext(mode?: PlayMode): number {
  const rounds = loadRounds();
  if (!mode) return currentStreakValue(rounds);
  return currentStreakValue(rounds.filter((r) => (r.mode ?? 'direction') === mode));
}
