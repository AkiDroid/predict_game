import { randomUUID } from 'node:crypto';
import { BarSeries } from './binary.ts';
import { type RoundStore, type StoredRound } from './roundStore.ts';
import {
  BRACKET_MAX_BARS,
  DEFAULT_BRACKET_ATR_MULTIPLE,
  defaultBracketDistance,
  makeBracket,
  minBracketDistance,
  PRICE_TICK,
  resolveOhlcTouch,
  snapDistance,
} from '../src/lib/bracket.ts';
import { barEndUnix } from '../src/lib/resample.ts';
import { normalizeAtrMultiple, pickBalancedDraw, BALANCED_DRAW_LIMIT } from '../src/lib/sampling.ts';
import { barDirection } from '../src/lib/score.ts';
import { decisionMeta, sessionBucket, sessionFilterApplies } from '../src/lib/session.ts';
import type {
  Bar,
  BracketReveal,
  Direction,
  GameFilters,
  PlayMode,
  RangeBucket,
  RevealResult,
  RoundContext,
  SamplingMode,
  SessionBucket,
  SymbolId,
  Timeframe,
  VolBucket,
} from '../src/lib/types.ts';
import { rangeBucketFromBody, tercileThresholds, volBucketFromAtrPct } from '../src/lib/volatility.ts';

const MIN_CONTEXT = 200;
const ATR_PERIOD = 14;

export interface RoundDrawOptions {
  sampling?: SamplingMode;
  samplingSessionId?: string;
  /** Used for balanced bracket rounds. Also becomes the in-game default distance. */
  atrMultiple?: number;
}

type BracketSide = 'up' | 'down' | 'none';

/** Two bits per last-bar index: 0 = not computed yet, else BRACKET_SIDES[code]. */
interface BracketLabels {
  bits: Uint8Array;
  known: number;
}

const BRACKET_SIDES: readonly (BracketSide | null)[] = [null, 'up', 'down', 'none'];
const BRACKET_SIDE_CODE: Record<BracketSide, number> = { up: 1, down: 2, none: 3 };

/**
 * Sorted indices `first <= i < end` minus a sorted `skipped` list. Most bars are
 * eligible, so this stores the few exclusions instead of every index.
 */
class IndexPool {
  readonly length: number;
  private readonly first: number;
  private readonly end: number;
  private readonly skipped: Int32Array;

  constructor(first: number, end: number, skipped: Int32Array) {
    this.first = first;
    this.end = end;
    this.skipped = skipped;
    this.length = Math.max(0, end - first - skipped.length);
  }

  get bytes(): number {
    return this.skipped.byteLength;
  }

  /** The k-th eligible index, 0 <= k < length. */
  at(k: number): number {
    const skipped = this.skipped;
    let lo = 0;
    let hi = skipped.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (skipped[mid]! - this.first - mid <= k) lo = mid + 1;
      else hi = mid;
    }
    return this.first + k + lo;
  }

  /** Number of eligible indices below `value`: the position of the first one >= `value`. */
  rank(value: number): number {
    if (value <= this.first) return 0;
    const v = Math.min(value, this.end);
    return v - this.first - lowerBound(this.skipped, v);
  }

  /** First eligible index at positions [lo, hi) that passes `test`, or -1. Visits them in order. */
  find(lo: number, hi: number, test: (index: number) => boolean): number {
    if (lo >= hi) return -1;
    const skipped = this.skipped;
    let i = this.at(lo);
    let j = lowerBound(skipped, i);
    for (let p = lo; p < hi; p++) {
      if (test(i)) return i;
      i++;
      while (j < skipped.length && skipped[j] === i) {
        i++;
        j++;
      }
    }
    return -1;
  }
}

const NO_SAMPLES = '没有符合条件的样本（检查日期/时段过滤，或数据是否已预处理）';
const SESSION_ORDER: SessionBucket[] = ['asia', 'europe', 'america_rth', 'america_eth'];
const SESSION_CODE = Object.fromEntries(SESSION_ORDER.map((s, i) => [s, i])) as Record<SessionBucket, number>;
const ALL_SESSIONS_MASK = (1 << SESSION_ORDER.length) - 1;
const SESSION_REJECTION_TRIES = 64;
/** Balanced bracket labels: at most this many symbol/tf/multiple label arrays (2 bits per bar each). */
export const BRACKET_LABEL_MAPS = 16;

export class GameEngine {
  private series = new Map<string, BarSeries>();
  private readonly rounds: RoundStore;
  private readonly random: () => number;
  private volThresholds = new Map<string, { lowMax: number; midMax: number }>();
  private rangeThresholds = new Map<string, { lowMax: number; midMax: number }>();
  private basePools = new Map<string, IndexPool>();
  private sessionCodeCache = new Map<string, Uint8Array>();
  private bracketLabels = new Map<string, BracketLabels>();
  /** Period end of each bar of a '1d' series, which would otherwise need a calendar lookup. */
  private dailyEnds = new WeakMap<BarSeries, Float64Array>();

  constructor(rounds: RoundStore, random: () => number = Math.random) {
    this.rounds = rounds;
    this.random = random;
  }

  setSeries(symbol: SymbolId, tf: Timeframe, series: BarSeries): void {
    const key = `${symbol}:${tf}`;
    this.series.set(key, series);
    this.volThresholds.delete(key);
    this.rangeThresholds.delete(key);
    this.sessionCodeCache.delete(key);
    for (const mode of ['direction', 'bracket'] as const) this.basePools.delete(`${key}:${mode}`);
    // Labels read the play series and the symbol's 1m path.
    for (const labelKey of [...this.bracketLabels.keys()]) {
      if (labelKey.startsWith(`${symbol}:`)) this.bracketLabels.delete(labelKey);
    }
    if (tf === '1d') {
      const ends = new Float64Array(series.length);
      for (let i = 0; i < series.length; i++) ends[i] = barEndUnix(series.t[i], tf);
      this.dailyEnds.set(series, ends);
    }
  }

  /** Builds every series' sampling caches now, so the first round on each does not pay for them. */
  prewarm(): void {
    for (const key of this.series.keys()) {
      const [symbol, tf] = key.split(':') as [SymbolId, Timeframe];
      this.ensureThresholds(symbol, tf);
      this.basePool(symbol, tf, 'direction');
      this.basePool(symbol, tf, 'bracket');
      if (sessionFilterApplies(tf)) this.sessionCodes(symbol, tf);
    }
  }

  private barEnd(s: BarSeries, tf: Timeframe, i: number): number {
    if (tf === '1d') {
      const ends = this.dailyEnds.get(s);
      if (ends) return ends[i]!;
    }
    return barEndUnix(s.t[i], tf);
  }

  getSeries(symbol: SymbolId, tf: Timeframe): BarSeries {
    const s = this.series.get(`${symbol}:${tf}`);
    if (!s) throw new Error(`数据未加载: ${symbol} ${tf}`);
    return s;
  }

  has(symbol: SymbolId, tf: Timeframe): boolean {
    return this.series.has(`${symbol}:${tf}`);
  }

  listLoaded(): { symbol: string; tf: string; count: number }[] {
    return [...this.series.entries()].map(([k, s]) => {
      const [symbol, tf] = k.split(':');
      return { symbol, tf, count: s.length };
    });
  }

  private ensureThresholds(symbol: SymbolId, playTf: Timeframe): void {
    const key = `${symbol}:${playTf}`;
    if (this.volThresholds.has(key)) return;
    const s = this.getSeries(symbol, playTf);
    const atrPcts: number[] = [];
    const bodies: number[] = [];
    const step = Math.max(1, Math.floor(s.length / 5000));
    for (let i = ATR_PERIOD + 1; i < s.length; i += step) {
      const a = this.atrAt(s, i, ATR_PERIOD);
      const px = s.c[i];
      if (px > 0) atrPcts.push(a / px);
      bodies.push(Math.abs(s.c[i] - s.o[i]));
    }
    this.volThresholds.set(key, tercileThresholds(atrPcts));
    this.rangeThresholds.set(key, tercileThresholds(bodies));
  }

  private atrAt(s: BarSeries, lastIndex: number, period = ATR_PERIOD): number {
    if (lastIndex < 1 || period < 1) return 0;
    const start = Math.max(1, lastIndex - period + 1);
    let sum = 0;
    let n = 0;
    for (let i = start; i <= lastIndex; i++) {
      const tr = Math.max(
        s.h[i] - s.l[i],
        Math.abs(s.h[i] - s.c[i - 1]),
        Math.abs(s.l[i] - s.c[i - 1]),
      );
      sum += tr;
      n++;
    }
    return n ? sum / n : 0;
  }

  private trAt(s: BarSeries, i: number): number {
    return Math.max(
      s.h[i] - s.l[i],
      Math.abs(s.h[i] - s.c[i - 1]),
      Math.abs(s.l[i] - s.c[i - 1]),
    );
  }

  /** Sorted last-bar indices that can start a round, before any user filter. One per symbol/tf/mode. */
  private basePool(symbol: SymbolId, playTf: Timeframe, mode: PlayMode): IndexPool {
    const key = `${symbol}:${playTf}:${mode}`;
    const cached = this.basePools.get(key);
    if (cached) return cached;

    const s = this.getSeries(symbol, playTf);
    const end = Math.max(MIN_CONTEXT, s.length - 1);
    const skipped: number[] = [];
    if (mode === 'bracket') {
      const trRing = new Float64Array(ATR_PERIOD);
      let sum = 0;
      for (let i = 1; i < s.length - 1; i++) {
        const tr = this.trAt(s, i);
        sum += tr;
        const slot = (i - 1) % ATR_PERIOD;
        if (i > ATR_PERIOD) sum -= trRing[slot];
        trRing[slot] = tr;
        if (i >= MIN_CONTEXT && !(sum > 0)) skipped.push(i);
      }
    } else {
      for (let i = MIN_CONTEXT; i < s.length - 1; i++) {
        if (s.c[i + 1] === s.o[i + 1]) skipped.push(i);
      }
    }
    const pool = new IndexPool(MIN_CONTEXT, end, Int32Array.from(skipped));
    this.basePools.set(key, pool);
    return pool;
  }

  /** Session code (index into SESSION_ORDER) of each bar's open time. One per symbol/tf. */
  private sessionCodes(symbol: SymbolId, tf: Timeframe): Uint8Array {
    const key = `${symbol}:${tf}`;
    const cached = this.sessionCodeCache.get(key);
    if (cached) return cached;
    const s = this.getSeries(symbol, tf);
    const codes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) codes[i] = SESSION_CODE[sessionBucket(s.t[i])];
    this.sessionCodeCache.set(key, codes);
    return codes;
  }

  /**
   * Uniform sampler over eligible last-bar indices whose decision time — the
   * predicted bar's open, `t[i + 1]` — passes the date and session filters.
   * Dates narrow the cached pool by binary search; sessions use rejection
   * sampling with an exact counting fallback, so nothing per-request is cached.
   */
  private eligibleSampler(
    symbol: SymbolId,
    playTf: Timeframe,
    filters: GameFilters,
    mode: PlayMode,
  ): () => number {
    const s = this.getSeries(symbol, playTf);
    const pool = this.basePool(symbol, playTf, mode);
    let lo = 0;
    let hi = pool.length;
    if (filters.dateFrom != null) {
      lo = pool.rank(s.indexAtOrAfter(filters.dateFrom) - 1);
    }
    if (filters.dateTo != null) {
      hi = pool.rank(s.indexAtOrAfter(Math.floor(filters.dateTo) + 1) - 1);
    }
    if (lo >= hi) throw new Error(NO_SAMPLES);
    const span = hi - lo;

    let mask = 0;
    if (sessionFilterApplies(playTf)) {
      for (const session of filters.sessions ?? []) mask |= 1 << SESSION_CODE[session];
    }
    if (mask === 0 || mask === ALL_SESSIONS_MASK) {
      return () => pool.at(lo + Math.floor(this.random() * span));
    }

    const codes = this.sessionCodes(symbol, playTf);
    const matches = (i: number) => ((mask >> codes[i + 1]!) & 1) === 1;
    let total = -1;
    return () => {
      for (let n = 0; n < SESSION_REJECTION_TRIES; n++) {
        const i = pool.at(lo + Math.floor(this.random() * span));
        if (matches(i)) return i;
      }
      if (total < 0) {
        total = 0;
        pool.find(lo, hi, (i) => {
          if (matches(i)) total++;
          return false;
        });
      }
      if (total === 0) throw new Error(NO_SAMPLES);
      let k = Math.floor(this.random() * total);
      const picked = pool.find(lo, hi, (i) => matches(i) && k-- === 0);
      if (picked < 0) throw new Error(NO_SAMPLES);
      return picked;
    };
  }

  cacheSizes(): {
    pools: number;
    poolBytes: number;
    sessionCodes: number;
    bracketMaps: number;
    bracketLabels: number;
    bracketLabelBytes: number;
  } {
    let poolBytes = 0;
    for (const p of this.basePools.values()) poolBytes += p.bytes;
    let bracketLabels = 0;
    let bracketLabelBytes = 0;
    for (const m of this.bracketLabels.values()) {
      bracketLabels += m.known;
      bracketLabelBytes += m.bits.byteLength;
    }
    return {
      pools: this.basePools.size,
      poolBytes,
      sessionCodes: this.sessionCodeCache.size,
      bracketMaps: this.bracketLabels.size,
      bracketLabels,
      bracketLabelBytes,
    };
  }

  countPending(): number {
    return this.rounds.countPending();
  }

  createRound(
    symbol: SymbolId,
    playTf: Timeframe,
    filters: GameFilters = {},
    mode: PlayMode = 'direction',
    userId: string | null = null,
    draw: RoundDrawOptions = {},
  ): RoundContext {
    this.ensureThresholds(symbol, playTf);
    const sampling = draw.sampling === 'balanced' ? 'balanced' : 'random';
    const atrMultiple =
      mode === 'bracket' && sampling === 'balanced'
        ? normalizeAtrMultiple(draw.atrMultiple)
        : DEFAULT_BRACKET_ATR_MULTIPLE;
    const lastIdx =
      sampling === 'balanced'
        ? this.pickBalancedIndex(symbol, playTf, filters, mode, atrMultiple)
        : this.pickRandomIndex(symbol, playTf, filters, mode);
    const nextIdx = lastIdx + 1;
    const s = this.getSeries(symbol, playTf);
    const lastBar = s.at(lastIdx);
    const cutoff = s.t[nextIdx]; // open of predicted bar
    // Sanity: last bar must end <= cutoff
    if (this.barEnd(s, playTf, lastIdx) > cutoff) {
      throw new Error('内部错误：cutoff 与 last bar 不一致');
    }

    const a = this.atrAt(s, lastIdx);
    const atrPct = lastBar.c > 0 ? a / lastBar.c : 0;
    const th = this.volThresholds.get(`${symbol}:${playTf}`)!;
    const volBucket = volBucketFromAtrPct(atrPct, th.lowMax, th.midMax);

    // recent return using proxy
    let recent = 0;
    const lb = 20;
    if (lastIdx >= lb && s.c[lastIdx - lb] !== 0) {
      recent = (s.c[lastIdx] - s.c[lastIdx - lb]) / s.c[lastIdx - lb];
    }

    const roundId = randomUUID();
    const createdAt = Date.now();
    this.rounds.expireOlderThan(createdAt);
    this.rounds.insert({
      id: roundId,
      userId,
      symbol,
      playTf,
      mode,
      lastIdx,
      nextIdx,
      cutoff,
      volBucket,
      createdAt,
    });

    return {
      roundId,
      symbol,
      playTf,
      cutoff,
      lastBar,
      atr: a,
      atrPct,
      recentReturn: recent,
      volBucket,
      ...decisionMeta(cutoff, playTf),
      minDistance: minBracketDistance(a, PRICE_TICK),
      defaultAtrMultiple: atrMultiple,
    };
  }

  reveal(roundId: string, predicted: Direction): RevealResult & {
    meta: {
      session: SessionBucket;
      hour: number;
      dayOfWeek: number;
      barRange: number;
      rangeBucket: RangeBucket;
      volBucket: VolBucket;
      cutoff: number;
      nextBarEnd: number;
      nextBar: Bar;
      symbol: SymbolId;
      playTf: Timeframe;
    };
  } {
    const p = this.requirePending(roundId);
    if (p.mode !== 'direction') throw new Error('该回合不是方向预测');
    if (!this.rounds.claim(roundId)) throw new Error('回合已失效，请开始新一局');
    const s = this.getSeries(p.symbol, p.playTf);
    const nextBar = s.at(p.nextIdx);
    const actual = barDirection(nextBar);
    if (actual === null) throw new Error('目标K线为十字星，不应进入题库');
    const correct = predicted === actual;
    const body = Math.abs(nextBar.c - nextBar.o);
    const rth = this.rangeThresholds.get(`${p.symbol}:${p.playTf}`)!;
    const rangeBucket = rangeBucketFromBody(body, rth.lowMax, rth.midMax);

    const nextBarEnd = this.barEnd(s, p.playTf, p.nextIdx);
    return {
      nextBar,
      actual,
      correct,
      predicted,
      meta: {
        ...decisionMeta(p.cutoff, p.playTf),
        barRange: body,
        rangeBucket,
        volBucket: p.volBucket,
        cutoff: p.cutoff,
        nextBarEnd,
        nextBar,
        symbol: p.symbol,
        playTf: p.playTf,
      },
    };
  }

  revealBracket(roundId: string, direction: Direction, distance: number): BracketReveal {
    const p = this.requirePending(roundId);
    if (p.mode !== 'bracket') throw new Error('该回合不是止盈止损模式');
    if (direction !== 'up' && direction !== 'down') throw new Error('方向无效');

    const play = this.getSeries(p.symbol, p.playTf);
    const entry = play.c[p.lastIdx];
    const atr = this.atrAt(play, p.lastIdx);
    const minD = minBracketDistance(atr, PRICE_TICK);
    if (!Number.isFinite(distance) || distance < minD - PRICE_TICK * 0.5) {
      throw new Error(`止盈止损距离不能小于 1×ATR（${minD.toFixed(2)}）`);
    }
    this.getSeries(p.symbol, '1m');
    if (!this.rounds.claim(roundId)) throw new Error('回合已失效，请开始新一局');
    const d = snapDistance(Math.max(distance, minD), minD, PRICE_TICK);
    const levels = makeBracket(entry, direction, d);

    let outcome: BracketReveal['outcome'] = 'unresolved';
    let hitTime: number | null = null;
    let hitBar: Bar | null = null;
    let barsToHit: number | null = null;
    let revealUntil = p.cutoff;

    const touch = this.findBracketTouch(p.symbol, p.playTf, p.lastIdx, levels.takeProfit, levels.stopLoss);
    if (touch) {
      outcome = touch.outcome;
      hitTime = touch.hitTime;
      const playIdx = play.indexAtOrBefore(touch.hitTime);
      const idx = playIdx < p.nextIdx ? p.nextIdx : playIdx;
      hitBar = play.at(idx);
      barsToHit = idx - p.nextIdx + 1;
      revealUntil = this.barEnd(play, p.playTf, idx);
    } else if (Math.min(play.length - 1, p.nextIdx + BRACKET_MAX_BARS - 1) >= p.nextIdx) {
      const maxIdx = Math.min(play.length - 1, p.nextIdx + BRACKET_MAX_BARS - 1);
      revealUntil = this.barEnd(play, p.playTf, maxIdx);
    }

    const correct = outcome === 'tp' ? true : outcome === 'sl' ? false : null;
    const actual: Direction | null =
      outcome === 'unresolved' ? null : outcome === 'tp' ? direction : direction === 'up' ? 'down' : 'up';
    return {
      outcome,
      correct,
      direction,
      predicted: direction,
      actual,
      entry,
      takeProfit: levels.takeProfit,
      stopLoss: levels.stopLoss,
      distance: d,
      atr,
      barsToHit,
      hitTime,
      revealUntil,
      hitBar,
      meta: {
        ...decisionMeta(p.cutoff, p.playTf),
        barRange: hitBar ? Math.abs(hitBar.c - hitBar.o) : 0,
        rangeBucket: null,
        volBucket: p.volBucket,
        cutoff: p.cutoff,
        nextBarEnd: revealUntil,
        symbol: p.symbol,
        playTf: p.playTf,
      },
    };
  }

  getBars(opts: {
    symbol: SymbolId;
    tf: Timeframe;
    /** Exclusive open-time upper bound for windowing (pan). */
    before?: number;
    /** Inclusive open-time lower bound for windowing. */
    after?: number;
    limit?: number;
    /** If set, censor so barEnd <= cutoff (no future leakage). */
    cutoff?: number | null;
  }): Bar[] {
    const s = this.getSeries(opts.symbol, opts.tf);
    const limit = Math.min(opts.limit ?? 500, 8000);

    let endIdx = s.length;
    if (opts.before != null) endIdx = s.indexAtOrAfter(opts.before);
    if (opts.cutoff != null) endIdx = this.visibleEnd(s, opts.tf, opts.cutoff, endIdx);

    let startIdx = 0;
    if (opts.after != null) {
      startIdx = s.indexAtOrAfter(opts.after);
      if (startIdx >= endIdx) return [];
      return s.slice(startIdx, Math.min(endIdx, startIdx + limit));
    }
    startIdx = Math.max(0, endIdx - limit);
    return s.slice(startIdx, endIdx);
  }

  /** Exclusive end index of bars whose period ends at or before `cutoff`, clipped to `endIdx`. */
  private visibleEnd(s: BarSeries, tf: Timeframe, cutoff: number, endIdx: number): number {
    let lo = 0;
    let hi = endIdx - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.barEnd(s, tf, mid) <= cutoff) {
        last = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return last + 1;
  }

  getMeta(symbol: SymbolId, tf: Timeframe) {
    const s = this.getSeries(symbol, tf);
    return {
      symbol,
      tf,
      count: s.length,
      from: s.length ? s.t[0] : 0,
      to: s.length ? s.t[s.length - 1] : 0,
    };
  }

  private pickBalancedIndex(
    symbol: SymbolId,
    playTf: Timeframe,
    filters: GameFilters,
    mode: PlayMode,
    atrMultiple: number,
  ): number {
    const draw = this.eligibleSampler(symbol, playTf, filters, mode);
    const labels = mode === 'bracket' ? this.bracketLabelCache(symbol, playTf, atrMultiple) : null;
    const series = mode === 'direction' ? this.getSeries(symbol, playTf) : null;
    return pickBalancedDraw(
      this.random,
      draw,
      (index) => {
        if (mode === 'bracket') {
          const side = this.bracketSide(labels!, symbol, playTf, index, atrMultiple);
          return side === 'none' ? null : side;
        }
        return barDirection(series!.at(index + 1));
      },
      BALANCED_DRAW_LIMIT,
    );
  }

  private pickRandomIndex(symbol: SymbolId, playTf: Timeframe, filters: GameFilters, mode: PlayMode): number {
    return this.eligibleSampler(symbol, playTf, filters, mode)();
  }

  private bracketLabelCache(symbol: SymbolId, playTf: Timeframe, atrMultiple: number): BracketLabels {
    const key = `${symbol}:${playTf}:${atrMultiple}`;
    const cached = this.bracketLabels.get(key);
    if (cached) {
      this.bracketLabels.delete(key);
      this.bracketLabels.set(key, cached);
      return cached;
    }
    if (this.bracketLabels.size >= BRACKET_LABEL_MAPS) {
      const oldest = this.bracketLabels.keys().next().value;
      if (oldest != null) this.bracketLabels.delete(oldest);
    }
    const length = this.getSeries(symbol, playTf).length;
    const created: BracketLabels = { bits: new Uint8Array(Math.ceil(length / 4)), known: 0 };
    this.bracketLabels.set(key, created);
    return created;
  }

  private bracketSide(
    labels: BracketLabels,
    symbol: SymbolId,
    playTf: Timeframe,
    lastIdx: number,
    atrMultiple: number,
  ): BracketSide {
    const byte = lastIdx >> 2;
    const shift = (lastIdx & 3) * 2;
    const cached = BRACKET_SIDES[(labels.bits[byte]! >> shift) & 3];
    if (cached) return cached;
    const play = this.getSeries(symbol, playTf);
    const entry = play.c[lastIdx];
    const atr = this.atrAt(play, lastIdx);
    const minD = minBracketDistance(atr, PRICE_TICK);
    const distance = defaultBracketDistance(atr, minD, atrMultiple, PRICE_TICK);
    const hit = this.findBracketTouch(symbol, playTf, lastIdx, entry + distance, entry - distance);
    const label: BracketSide = hit == null ? 'none' : hit.outcome === 'tp' ? 'up' : 'down';
    labels.bits[byte]! |= BRACKET_SIDE_CODE[label] << shift;
    labels.known++;
    return label;
  }

  /**
   * First touch of the two prices. `takeProfit` is the upper check only when the
   * caller passed the higher price; reveal passes the real bracket levels.
   */
  private findBracketTouch(
    symbol: SymbolId,
    playTf: Timeframe,
    lastIdx: number,
    takeProfit: number,
    stopLoss: number,
  ): { outcome: 'tp' | 'sl'; hitTime: number } | null {
    const play = this.getSeries(symbol, playTf);
    const m1 = this.getSeries(symbol, '1m');
    const nextIdx = lastIdx + 1;
    const maxIdx = Math.min(play.length - 1, nextIdx + BRACKET_MAX_BARS - 1);
    if (maxIdx < nextIdx) return null;
    const scanUntil = this.barEnd(play, playTf, maxIdx);
    let i = m1.indexAtOrAfter(play.t[nextIdx]);
    let prev = play.c[lastIdx];
    if (playTf !== '1m') {
      // A play bar's 1m path stays inside [min(prevClose, low), max(prevClose, high)].
      // Bars that miss both prices are jumped by time instead of walked minute by minute.
      for (let j = nextIdx; j <= maxIdx && i < m1.length; j++) {
        const windowEnd = j === maxIdx ? scanUntil : play.t[j + 1];
        const lo = Math.min(prev, play.l[j]);
        const hi = Math.max(prev, play.h[j]);
        const reaches = (takeProfit >= lo && takeProfit <= hi) || (stopLoss >= lo && stopLoss <= hi);
        if (!reaches) {
          const next = m1.indexAtOrAfter(windowEnd);
          if (next > i) {
            prev = m1.c[next - 1];
            i = next;
          }
          continue;
        }
        for (; i < m1.length; i++) {
          const t = m1.t[i];
          if (t >= windowEnd) break;
          const touch = resolveOhlcTouch(prev, m1.o[i], m1.h[i], m1.l[i], m1.c[i], takeProfit, stopLoss);
          if (touch) return { outcome: touch, hitTime: t };
          prev = m1.c[i];
        }
      }
      return null;
    }
    for (; i < m1.length; i++) {
      const t = m1.t[i];
      if (t >= scanUntil) break;
      const touch = resolveOhlcTouch(prev, m1.o[i], m1.h[i], m1.l[i], m1.c[i], takeProfit, stopLoss);
      if (touch) return { outcome: touch, hitTime: t };
      prev = m1.c[i];
    }
    return null;
  }

  private requirePending(roundId: string): StoredRound {
    const round = this.rounds.peek(roundId);
    if (!round) throw new Error('回合已失效，请开始新一局');
    return round;
  }
}

/** First position in a sorted array whose value is >= `value`. */
function lowerBound(sorted: Int32Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
