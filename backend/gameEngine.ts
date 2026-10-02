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
import { censorBars } from '../src/lib/censor.ts';
import { barEndUnix } from '../src/lib/resample.ts';
import { normalizeAtrMultiple, pickFresh, SideDeck } from '../src/lib/sampling.ts';
import { barDirection, isDoji } from '../src/lib/score.ts';
import { sessionBucket } from '../src/lib/session.ts';
import { getChicagoParts, weekdayIndex } from '../src/lib/time.ts';
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
const BRACKET_PROBE_LIMIT = 80;
const MAX_BALANCE_SESSIONS = 200;

export interface RoundDrawOptions {
  sampling?: SamplingMode;
  samplingSessionId?: string;
  /** Used for balanced bracket rounds. Also becomes the in-game default distance. */
  atrMultiple?: number;
}

interface BracketLabelCache {
  byIndex: Map<number, 'up' | 'down' | 'none'>;
  pools: { up: number[]; down: number[] };
}

export class GameEngine {
  private series = new Map<string, BarSeries>();
  private readonly rounds: RoundStore;
  private readonly random: () => number;
  private volThresholds = new Map<string, { lowMax: number; midMax: number }>();
  private rangeThresholds = new Map<string, { lowMax: number; midMax: number }>();
  private eligibleCache = new Map<string, number[]>();
  private directionPools = new Map<string, { up: number[]; down: number[] }>();
  private bracketLabels = new Map<string, BracketLabelCache>();
  private decks = new Map<string, SideDeck>();

  constructor(rounds: RoundStore, random: () => number = Math.random) {
    this.rounds = rounds;
    this.random = random;
  }

  setSeries(symbol: SymbolId, tf: Timeframe, series: BarSeries): void {
    this.series.set(`${symbol}:${tf}`, series);
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

  private passesFilters(
    t: number,
    filters: GameFilters,
    sessionSet: Set<SessionBucket> | null,
  ): boolean {
    if (filters.dateFrom != null && t < filters.dateFrom) return false;
    if (filters.dateTo != null && t > filters.dateTo) return false;
    if (sessionSet && !sessionSet.has(sessionBucket(t))) return false;
    return true;
  }

  private buildEligible(
    symbol: SymbolId,
    playTf: Timeframe,
    filters: GameFilters,
    mode: PlayMode,
  ): number[] {
    const cacheKey = JSON.stringify({ symbol, playTf, filters, mode });
    const cached = this.eligibleCache.get(cacheKey);
    if (cached) return cached;

    const s = this.getSeries(symbol, playTf);
    const sessionSet = filters.sessions?.length ? new Set(filters.sessions) : null;
    const out: number[] = [];

    if (mode === 'bracket') {
      let sum = 0;
      let count = 0;
      for (let i = 1; i < s.length - 1; i++) {
        sum += this.trAt(s, i);
        count++;
        if (count > ATR_PERIOD) {
          sum -= this.trAt(s, i - ATR_PERIOD);
          count--;
        }
        if (i < MIN_CONTEXT || !(sum > 0)) continue;
        if (!this.passesFilters(s.t[i], filters, sessionSet)) continue;
        out.push(i);
      }
    } else {
      for (let i = MIN_CONTEXT; i < s.length - 1; i++) {
        if (isDoji(s.at(i + 1))) continue;
        if (!this.passesFilters(s.t[i], filters, sessionSet)) continue;
        out.push(i);
      }
    }
    this.eligibleCache.set(cacheKey, out);
    return out;
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
        ? this.pickBalancedIndex(symbol, playTf, filters, mode, userId, draw.samplingSessionId, atrMultiple)
        : this.pickRandomIndex(symbol, playTf, filters, mode);
    const nextIdx = lastIdx + 1;
    const s = this.getSeries(symbol, playTf);
    const lastBar = s.at(lastIdx);
    const cutoff = s.t[nextIdx]; // open of predicted bar
    // Sanity: last bar must end <= cutoff
    if (barEndUnix(lastBar.t, playTf) > cutoff) {
      throw new Error('内部错误：cutoff 与 last bar 不一致');
    }

    const a = this.atrAt(s, lastIdx);
    const atrPct = lastBar.c > 0 ? a / lastBar.c : 0;
    const th = this.volThresholds.get(`${symbol}:${playTf}`)!;
    const volBucket = volBucketFromAtrPct(atrPct, th.lowMax, th.midMax);
    const parts = getChicagoParts(lastBar.t);

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
      session: sessionBucket(lastBar.t),
      hour: parts.hour,
      dayOfWeek: weekdayIndex(lastBar.t),
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
    const parts = getChicagoParts(p.cutoff);

    const nextBarEnd = barEndUnix(nextBar.t, p.playTf);
    return {
      nextBar,
      actual,
      correct,
      predicted,
      meta: {
        session: sessionBucket(p.cutoff),
        hour: parts.hour,
        dayOfWeek: weekdayIndex(p.cutoff),
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
      revealUntil = barEndUnix(play.t[idx], p.playTf);
    } else if (Math.min(play.length - 1, p.nextIdx + BRACKET_MAX_BARS - 1) >= p.nextIdx) {
      const maxIdx = Math.min(play.length - 1, p.nextIdx + BRACKET_MAX_BARS - 1);
      revealUntil = barEndUnix(play.t[maxIdx], p.playTf);
    }

    const correct = outcome === 'tp' ? true : outcome === 'sl' ? false : null;
    const actual: Direction | null =
      outcome === 'unresolved' ? null : outcome === 'tp' ? direction : direction === 'up' ? 'down' : 'up';
    const parts = getChicagoParts(p.cutoff);
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
        session: sessionBucket(p.cutoff),
        hour: parts.hour,
        dayOfWeek: weekdayIndex(p.cutoff),
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

    // Determine exclusive end index in series by open time window
    let endIdx = s.length;
    if (opts.before != null) {
      endIdx = s.indexAtOrAfter(opts.before);
    }

    let candidates: Bar[];
    if (opts.cutoff != null) {
      candidates = censorBars(s.slice(0, endIdx), opts.tf, opts.cutoff);
    } else {
      candidates = s.slice(0, endIdx);
    }

    if (opts.after != null) {
      const i = candidates.findIndex((b) => b.t >= opts.after!);
      candidates = i < 0 ? [] : candidates.slice(i);
      return candidates.slice(0, limit);
    }

    return candidates.slice(Math.max(0, candidates.length - limit));
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

  /** Sides dealt to a balanced session, in order. Used to check the shuffle stayed 50/50. */
  balancedSidesDealt(samplingSessionId: string): Direction[] {
    const sides: Direction[] = [];
    for (const [key, deck] of this.decks) {
      if (key.includes(samplingSessionId)) sides.push(...deck.served);
    }
    return sides;
  }

  private pickRandomIndex(symbol: SymbolId, playTf: Timeframe, filters: GameFilters, mode: PlayMode): number {
    const eligible = this.buildEligible(symbol, playTf, filters, mode);
    if (eligible.length === 0) {
      throw new Error('没有符合条件的样本（检查日期/时段过滤，或数据是否已预处理）');
    }
    return eligible[Math.floor(this.random() * eligible.length)]!;
  }

  private pickBalancedIndex(
    symbol: SymbolId,
    playTf: Timeframe,
    filters: GameFilters,
    mode: PlayMode,
    userId: string | null,
    samplingSessionId: string | undefined,
    atrMultiple: number,
  ): number {
    const sessionId = samplingSessionId?.trim() ?? '';
    if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) {
      throw new Error('缺少本局出题会话，请从设置页重新开始');
    }
    const deck = this.takeDeck(
      JSON.stringify({ userId, sessionId, symbol, playTf, mode, filters, atrMultiple }),
    );
    const side = deck.peek();
    const index =
      mode === 'bracket'
        ? this.pickBalancedBracket(symbol, playTf, filters, atrMultiple, side, deck)
        : this.pickBalancedDirection(symbol, playTf, filters, side, deck);
    deck.markUsed(index);
    deck.commit();
    return index;
  }

  private pickBalancedDirection(
    symbol: SymbolId,
    playTf: Timeframe,
    filters: GameFilters,
    side: Direction,
    deck: SideDeck,
  ): number {
    const pools = this.directionSides(symbol, playTf, filters);
    if (pools.up.length === 0 || pools.down.length === 0) {
      throw new Error('当前条件下涨和跌样本不都够，无法按各 50% 出题。可以改成随机出题，或放宽日期和时段。');
    }
    const pool = pools[side];
    return (
      pickFresh(pool, (index) => deck.hasUsed(index), this.random) ??
      pool[Math.floor(this.random() * pool.length)]!
    );
  }

  private directionSides(
    symbol: SymbolId,
    playTf: Timeframe,
    filters: GameFilters,
  ): { up: number[]; down: number[] } {
    const key = JSON.stringify({ symbol, playTf, filters, kind: 'direction-side' });
    const cached = this.directionPools.get(key);
    if (cached) return cached;
    const eligible = this.buildEligible(symbol, playTf, filters, 'direction');
    const s = this.getSeries(symbol, playTf);
    const up: number[] = [];
    const down: number[] = [];
    for (const index of eligible) {
      const dir = barDirection(s.at(index + 1));
      if (dir === 'up') up.push(index);
      else if (dir === 'down') down.push(index);
    }
    const pools = { up, down };
    this.directionPools.set(key, pools);
    return pools;
  }

  private pickBalancedBracket(
    symbol: SymbolId,
    playTf: Timeframe,
    filters: GameFilters,
    atrMultiple: number,
    side: Direction,
    deck: SideDeck,
  ): number {
    const eligible = this.buildEligible(symbol, playTf, filters, 'bracket');
    if (eligible.length === 0) {
      throw new Error('没有符合条件的样本（检查日期/时段过滤，或数据是否已预处理）');
    }
    const labels = this.bracketLabelCache(symbol, playTf, atrMultiple);
    for (let n = 0; n < BRACKET_PROBE_LIMIT; n++) {
      const index = eligible[Math.floor(this.random() * eligible.length)]!;
      if (deck.hasUsed(index)) continue;
      if (this.bracketSide(labels, symbol, playTf, index, atrMultiple) === side) return index;
    }
    const known = pickFresh(labels.pools[side], (index) => deck.hasUsed(index), this.random);
    if (known != null) return known;
    if (labels.pools.up.length === 0 || labels.pools.down.length === 0) {
      throw new Error('按这个 ATR 倍率，很少能在期限内先碰到某一边。换一个倍率，或改成随机出题。');
    }
    throw new Error('这个 ATR 倍率下，先碰到某一边的新样本不够了。换一个倍率，或重新开始一局。');
  }

  private bracketLabelCache(symbol: SymbolId, playTf: Timeframe, atrMultiple: number): BracketLabelCache {
    const key = `${symbol}:${playTf}:${atrMultiple}`;
    const cached = this.bracketLabels.get(key);
    if (cached) return cached;
    const created: BracketLabelCache = {
      byIndex: new Map(),
      pools: { up: [], down: [] },
    };
    this.bracketLabels.set(key, created);
    return created;
  }

  private bracketSide(
    labels: BracketLabelCache,
    symbol: SymbolId,
    playTf: Timeframe,
    lastIdx: number,
    atrMultiple: number,
  ): 'up' | 'down' | 'none' {
    const cached = labels.byIndex.get(lastIdx);
    if (cached) return cached;
    const play = this.getSeries(symbol, playTf);
    const entry = play.c[lastIdx];
    const atr = this.atrAt(play, lastIdx);
    const minD = minBracketDistance(atr, PRICE_TICK);
    const distance = defaultBracketDistance(atr, minD, atrMultiple, PRICE_TICK);
    const hit = this.findBracketTouch(symbol, playTf, lastIdx, entry + distance, entry - distance);
    const label: 'up' | 'down' | 'none' = hit == null ? 'none' : hit.outcome === 'tp' ? 'up' : 'down';
    labels.byIndex.set(lastIdx, label);
    if (label !== 'none') labels.pools[label].push(lastIdx);
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
    const scanUntil = barEndUnix(play.t[maxIdx], playTf);
    const start = m1.indexAtOrAfter(play.t[nextIdx]);
    let prev = play.c[lastIdx];
    for (let i = start; i < m1.length; i++) {
      const t = m1.t[i];
      if (t >= scanUntil) break;
      const touch = resolveOhlcTouch(prev, m1.o[i], m1.h[i], m1.l[i], m1.c[i], takeProfit, stopLoss);
      if (touch) return { outcome: touch, hitTime: t };
      prev = m1.c[i];
    }
    return null;
  }

  private takeDeck(key: string): SideDeck {
    const existing = this.decks.get(key);
    if (existing) return existing;
    const deck = new SideDeck(this.random);
    this.decks.set(key, deck);
    while (this.decks.size > MAX_BALANCE_SESSIONS) {
      const oldest = this.decks.keys().next().value;
      if (oldest === undefined) break;
      this.decks.delete(oldest);
    }
    return deck;
  }

  private requirePending(roundId: string): StoredRound {
    const round = this.rounds.peek(roundId);
    if (!round) throw new Error('回合已失效，请开始新一局');
    return round;
  }
}
