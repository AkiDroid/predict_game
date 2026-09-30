import type {
  Bar,
  BracketReveal,
  Direction,
  GameFilters,
  PlayMode,
  RevealResult,
  RoundContext,
  SymbolId,
  Timeframe,
} from './types';

/** Empty in dev: Vite proxies `/api`. Set when the UI is hosted on another origin. */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

function api(path: string): string {
  return `${API_BASE}${path}`;
}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

export async function fetchHealth(): Promise<{
  ok: boolean;
  error?: string;
  loaded: { symbol: string; tf: string; count: number }[];
  timezone?: string;
}> {
  return parse(await fetch(api('/api/health')));
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
  const data = await parse<{ bars: Bar[] }>(await fetch(api(`/api/bars?${sp}`)));
  return data.bars;
}

export async function fetchMeta(symbol: SymbolId, tf: Timeframe) {
  return parse<{ symbol: string; tf: string; count: number; from: number; to: number }>(
    await fetch(api(`/api/meta?symbol=${symbol}&tf=${tf}`)),
  );
}

export async function nextRound(
  symbol: SymbolId,
  playTf: Timeframe,
  filters: GameFilters = {},
  mode: PlayMode = 'direction',
): Promise<RoundContext> {
  return parse(
    await fetch(api('/api/round/next'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, playTf, filters, mode }),
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
    await fetch(api('/api/round/reveal'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    await fetch(api('/api/round/reveal-bracket'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundId, direction, distance }),
    }),
  );
}
