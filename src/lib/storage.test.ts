import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as ref from './__fixtures__/statsReference';
import { randomRounds } from './__fixtures__/randomRounds';
import type { RoundRecord } from './types';

const api = vi.hoisted(() => ({
  fetchRounds: vi.fn<() => Promise<RoundRecord[]>>(),
  postRound: vi.fn<(r: RoundRecord) => Promise<void>>(),
  migrateRounds: vi.fn(),
  clearRoundsApi: vi.fn<() => Promise<void>>(),
}));

vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), ...api }));

const storage = await import('./storage');
const { ApiError } = await import('./api');

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.postRound.mockResolvedValue(undefined);
  api.clearRoundsApi.mockResolvedValue(undefined);
  storage.setRoundsCache([]);
});

describe('getStreakBeforeNext', () => {
  it('matches currentStreakValue over the mode-filtered rounds', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const n of [0, 1, 3, 40, 400]) {
        const rounds = randomRounds(seed * 31 + n, n);
        storage.setRoundsCache(rounds);
        expect(storage.getStreakBeforeNext()).toBe(ref.currentStreakValue(rounds));
        for (const mode of ['direction', 'bracket'] as const) {
          const filtered = rounds.filter((r) => (r.mode ?? 'direction') === mode);
          expect(storage.getStreakBeforeNext(mode)).toBe(ref.currentStreakValue(filtered));
        }
      }
    }
  });
});

describe('appendRound', () => {
  it('appends once per id with a new array identity, tolerating 409', async () => {
    const [a, b] = randomRounds(1, 2);
    storage.setRoundsCache([a]);
    const before = storage.loadRounds();
    const after = await storage.appendRound(b);
    expect(after).not.toBe(before);
    expect(before).toEqual([a]);
    expect(after).toEqual([a, b]);

    api.postRound.mockRejectedValueOnce(new ApiError('dup', 409));
    expect(await storage.appendRound(b)).toBe(after);
    expect(storage.loadRounds()).toEqual([a, b]);

    api.postRound.mockRejectedValueOnce(new ApiError('cap', 413));
    await expect(storage.appendRound(randomRounds(2, 1)[0])).rejects.toThrow('cap');
    expect(storage.loadRounds()).toEqual([a, b]);
  });

  it('keeps a round saved while a sync that started earlier is still loading', async () => {
    const [a, b] = randomRounds(3, 2);
    const load = deferred<RoundRecord[]>();
    api.fetchRounds.mockReturnValueOnce(load.promise);
    const sync = storage.migrateLocalIfNeeded();
    const appended = storage.appendRound(b);
    load.resolve([a]);
    await sync;
    expect(await appended).toEqual([a, b]);
    expect(storage.roundsSynced()).toBe(true);
  });

  it('does not duplicate a round the sync already returned', async () => {
    const [a, b] = randomRounds(4, 2);
    const load = deferred<RoundRecord[]>();
    api.fetchRounds.mockReturnValueOnce(load.promise);
    const sync = storage.hydrateRounds();
    const appended = storage.appendRound(b);
    load.resolve([a, b]);
    await sync;
    expect(await appended).toEqual([a, b]);
  });
});

describe('sync bookkeeping', () => {
  it('drops a load that finishes after sign-out', async () => {
    const load = deferred<RoundRecord[]>();
    api.fetchRounds.mockReturnValueOnce(load.promise);
    const sync = storage.migrateLocalIfNeeded();
    storage.setRoundsCache([]);
    load.resolve(randomRounds(5, 3));
    await sync;
    expect(storage.loadRounds()).toEqual([]);
    expect(storage.roundsSynced()).toBe(false);
  });

  it('shares an in-flight load and notifies subscribers on replacement', async () => {
    const rounds = randomRounds(6, 4);
    const load = deferred<RoundRecord[]>();
    api.fetchRounds.mockReturnValueOnce(load.promise);
    const seen: number[] = [];
    const off = storage.subscribeRounds(() => seen.push(storage.loadRounds().length));
    void storage.migrateLocalIfNeeded();
    const ready = storage.whenRoundsReady();
    load.resolve(rounds);
    expect(await ready).toBe(rounds);
    expect(api.fetchRounds).toHaveBeenCalledTimes(1);
    expect(storage.roundsSyncAge()).toBeLessThan(1000);
    await storage.clearRounds();
    off();
    expect(seen).toEqual([4, 0]);
  });

  it('whenRoundsReady resolves even when the load fails', async () => {
    api.fetchRounds.mockRejectedValueOnce(new Error('offline'));
    const sync = storage.migrateLocalIfNeeded();
    await expect(storage.whenRoundsReady()).resolves.toEqual([]);
    await expect(sync).rejects.toThrow('offline');
    expect(storage.roundsSynced()).toBe(false);
  });
});
