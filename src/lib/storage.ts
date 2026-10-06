import type { PlayMode, RoundRecord } from './types';
import { isScored } from './stats';
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
/** Ids in `cache`; rebuilt lazily whenever `cache` is replaced wholesale. */
let cacheIds: Set<string> | null = null;
/** Bumped whenever the cache is reset or replaced so in-flight loads for an older state are dropped. */
let generation = 0;
/** When the cache last matched the server (ms since epoch), or null if it never has this session. */
let syncedAt: number | null = null;
/** The current server load, so callers can share it instead of fetching twice. */
let pending: Promise<RoundRecord[]> | null = null;

const listeners = new Set<() => void>();

function replaceCache(rounds: RoundRecord[], fromServer: boolean): void {
  cache = rounds;
  cacheIds = null;
  syncedAt = fromServer ? Date.now() : null;
  for (const fn of listeners) fn();
}

function idsOfCache(): Set<string> {
  if (!cacheIds) cacheIds = new Set(cache.map((r) => r.id));
  return cacheIds;
}

export function loadRounds(): RoundRecord[] {
  return cache;
}

export function setRoundsCache(rounds: RoundRecord[]): void {
  generation++;
  pending = null;
  replaceCache(rounds, false);
}

/** True once the cache has been loaded from the server in this session. */
export function roundsSynced(): boolean {
  return syncedAt != null;
}

/** Milliseconds since the cache last matched the server, or Infinity if it never has. */
export function roundsSyncAge(): number {
  return syncedAt == null ? Infinity : Date.now() - syncedAt;
}

/** Resolves with the cache once any in-flight server load settles (never rejects). */
export async function whenRoundsReady(): Promise<RoundRecord[]> {
  if (pending) await pending.catch(() => undefined);
  return cache;
}

/** Called whenever the cache is replaced (sync, hydrate, clear, sign-out); not on append. */
export function subscribeRounds(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Run `load` as the current server load; its result only lands if nothing reset the cache meanwhile. */
function track(load: () => Promise<RoundRecord[]>): Promise<RoundRecord[]> {
  const gen = ++generation;
  const p = load().then((rounds) => {
    if (gen === generation) replaceCache(rounds, true);
    return gen === generation ? rounds : cache;
  });
  pending = p;
  const clear = () => {
    if (pending === p) pending = null;
  };
  p.then(clear, clear);
  return p;
}

export async function hydrateRounds(): Promise<RoundRecord[]> {
  return track(fetchRounds);
}

export async function appendRound(round: RoundRecord): Promise<RoundRecord[]> {
  try {
    await postRound(round);
  } catch (err) {
    // 409: an earlier attempt was stored but its response was lost.
    if (!(err instanceof ApiError && err.status === 409)) throw err;
  }
  // A load that started before the POST would otherwise replace the cache without this round.
  await whenRoundsReady();
  const ids = idsOfCache();
  if (!ids.has(round.id)) {
    // New array identity on change, as before: React state holding the old array must not mutate.
    cache = [...cache, round];
    ids.add(round.id);
  }
  return cache;
}

export async function clearRounds(): Promise<void> {
  await clearRoundsApi();
  generation++;
  pending = null;
  replaceCache([], true);
}

export function getStreakBeforeNext(mode?: PlayMode): number {
  // Same as currentStreakValue over the mode-filtered rounds, without building the filtered copy.
  const rounds = loadRounds();
  let s = 0;
  let last: boolean | null = null;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i];
    if (mode && (r.mode ?? 'direction') !== mode) continue;
    if (!isScored(r)) continue;
    const win = r.correct === true;
    if (last === null) last = win;
    else if (win !== last) break;
    s++;
  }
  if (last === null) return 0;
  return last ? s : -s;
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
  await track(async () => {
    const local = peekLocalRounds();
    if (local.length === 0) return fetchRounds();
    const server = await fetchRounds();
    if (server.length > 0) {
      clearLocalRounds();
      return server;
    }
    await migrateRounds(local);
    clearLocalRounds();
    return local;
  });
}
