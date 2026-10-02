import type {
  Bar,
  BracketReveal,
  Direction,
  GameFilters,
  PlayMode,
  RevealResult,
  SamplingMode,
  RoundContext,
  RoundRecord,
  SymbolId,
  Timeframe,
} from './types';

/** Empty in dev: Vite proxies `/api`. Set when the UI is hosted on another origin. */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

function api(path: string): string {
  return `${API_BASE}${path}`;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function parse<T>(res: Response): Promise<T> {
  let data: { error?: string } = {};
  try {
    data = (await res.json()) as { error?: string };
  } catch {
    data = {};
  }
  if (!res.ok) throw new ApiError(data.error || res.statusText, res.status);
  return data as T;
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(api(path), {
    ...init,
    credentials: 'include',
    headers,
  });
}

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
};

export async function fetchHealth(): Promise<{
  ok: boolean;
  error?: string;
  loaded: { symbol: string; tf: string; count: number }[];
  timezone?: string;
}> {
  return parse(await request('/api/health'));
}

export async function fetchMe(): Promise<AuthUser> {
  const data = await parse<{ user: AuthUser }>(await request('/api/auth/me'));
  return data.user;
}

export async function registerUser(username: string, password: string): Promise<AuthUser> {
  const data = await parse<{ user: AuthUser }>(
    await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  );
  return data.user;
}

export async function loginUser(username: string, password: string): Promise<AuthUser> {
  const data = await parse<{ user: AuthUser }>(
    await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  );
  return data.user;
}

export async function logoutUser(): Promise<void> {
  await parse(await request('/api/auth/logout', { method: 'POST' }));
}

export async function fetchRounds(): Promise<RoundRecord[]> {
  const data = await parse<{ rounds: RoundRecord[] }>(await request('/api/stats/rounds'));
  return data.rounds;
}

export async function postRound(round: RoundRecord): Promise<void> {
  await parse(await request('/api/stats/rounds', { method: 'POST', body: JSON.stringify(round) }));
}

export async function migrateRounds(rounds: RoundRecord[]): Promise<{ migrated: boolean; count: number }> {
  return parse(
    await request('/api/stats/migrate', {
      method: 'POST',
      body: JSON.stringify({ rounds }),
    }),
  );
}

export async function clearRoundsApi(): Promise<void> {
  await parse(await request('/api/stats/rounds', { method: 'DELETE' }));
}

export async function fetchBars(params: {
  symbol: SymbolId;
  tf: Timeframe;
  before?: number;
  after?: number;
  cutoff?: number | null;
  limit?: number;
}): Promise<Bar[]> {
  const sp = new URLSearchParams({
    symbol: params.symbol,
    tf: params.tf,
  });
  if (params.before != null) sp.set('before', String(params.before));
  if (params.after != null) sp.set('after', String(params.after));
  if (params.cutoff != null) sp.set('cutoff', String(params.cutoff));
  if (params.limit != null) sp.set('limit', String(params.limit));
  const data = await parse<{ bars: Bar[] }>(await request(`/api/bars?${sp}`));
  return data.bars;
}

export async function fetchMeta(symbol: SymbolId, tf: Timeframe) {
  return parse<{ symbol: string; tf: string; count: number; from: number; to: number }>(
    await request(`/api/meta?symbol=${symbol}&tf=${tf}`),
  );
}

export async function nextRound(
  symbol: SymbolId,
  playTf: Timeframe,
  filters: GameFilters = {},
  mode: PlayMode = 'direction',
  draw: {
    sampling?: SamplingMode;
    atrMultiple?: number;
    samplingSessionId?: string;
  } = {},
): Promise<RoundContext> {
  const payload: {
    symbol: SymbolId;
    playTf: Timeframe;
    filters: GameFilters;
    mode: PlayMode;
    sampling?: SamplingMode;
    atrMultiple?: number;
    samplingSessionId?: string;
  } = { symbol, playTf, filters, mode };
  if (draw.sampling) payload.sampling = draw.sampling;
  if (draw.atrMultiple != null) payload.atrMultiple = draw.atrMultiple;
  if (draw.samplingSessionId && draw.samplingSessionId.length >= 8) {
    payload.samplingSessionId = draw.samplingSessionId;
  }
  return parse(
    await request('/api/round/next', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  );
}

export async function revealRound(
  roundId: string,
  predicted: Direction,
): Promise<
  RevealResult & {
    meta: {
      session: string;
      hour: number;
      dayOfWeek: number;
      barRange: number;
      rangeBucket: string;
      volBucket: string;
      cutoff: number;
      nextBarEnd: number;
      nextBar: Bar;
      symbol: SymbolId;
      playTf: Timeframe;
    };
  }
> {
  return parse(
    await request('/api/round/reveal', {
      method: 'POST',
      body: JSON.stringify({ roundId, predicted }),
    }),
  );
}

export async function revealBracket(
  roundId: string,
  direction: Direction,
  distance: number,
): Promise<BracketReveal> {
  return parse(
    await request('/api/round/reveal-bracket', {
      method: 'POST',
      body: JSON.stringify({ roundId, direction, distance }),
    }),
  );
}
