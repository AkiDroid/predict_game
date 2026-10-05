import type { PlayMode, RoundRecord } from './types';
import { currentStreakValue } from './stats';
import {
  ApiError,
  clearRoundsApi,
  fetchRounds,
  migrateRounds,
  postRound,
} from './api';

const LOCAL_KEY = 'predict_game_rounds_v1';

/** In-memory cache of the logged-in user's rounds (server is source of truth). */
let cache: RoundRecord[] = [];

export function loadRounds(): RoundRecord[] {
  return cache;
}

export function setRoundsCache(rounds: RoundRecord[]): void {
  cache = rounds;
}

export async function hydrateRounds(): Promise<RoundRecord[]> {
  const rounds = await fetchRounds();
  cache = rounds;
  return rounds;
}

export async function appendRound(round: RoundRecord): Promise<RoundRecord[]> {
  try {
    await postRound(round);
  } catch (err) {
    // 409: an earlier attempt was stored but its response was lost.
    if (!(err instanceof ApiError && err.status === 409)) throw err;
  }
  if (!cache.some((r) => r.id === round.id)) cache = [...cache, round];
  return cache;
}

export async function clearRounds(): Promise<void> {
  await clearRoundsApi();
  cache = [];
}

export function getStreakBeforeNext(mode?: PlayMode): number {
  const rounds = loadRounds();
  if (!mode) return currentStreakValue(rounds);
  return currentStreakValue(rounds.filter((r) => (r.mode ?? 'direction') === mode));
}

/** Read legacy localStorage rounds (pre-auth). */
export function peekLocalRounds(): RoundRecord[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RoundRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function clearLocalRounds(): void {
  localStorage.removeItem(LOCAL_KEY);
}

/**
 * If the server has no rounds yet and the browser still has legacy localStorage
 * data, upload once then clear localStorage so it is no longer the source of truth.
 */
export async function migrateLocalIfNeeded(): Promise<void> {
  const local = peekLocalRounds();
  if (local.length === 0) {
    await hydrateRounds();
    return;
  }
  const server = await fetchRounds();
  if (server.length > 0) {
    clearLocalRounds();
    cache = server;
    return;
  }
  await migrateRounds(local);
  clearLocalRounds();
  cache = local;
}
