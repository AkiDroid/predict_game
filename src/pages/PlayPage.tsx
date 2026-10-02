import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CandleChart, type ChartBracket } from '../components/CandleChart';
import { TimeframeBar } from '../components/TimeframeBar';
import { fetchBars, nextRound, revealBracket, revealRound } from '../lib/api';
import {
  BRACKET_MAX_BARS,
  DEFAULT_BRACKET_ATR_MULTIPLE,
  defaultBracketDistance,
  formatAtrMultiple,
  makeBracket,
  PRICE_TICK,
  snapDistance,
  type Bracket,
} from '../lib/bracket';
import { maxVisibleOpen } from '../lib/censor';
import { SESSION_LABELS } from '../lib/session';
import { loadSettings, saveSettings } from '../lib/settings';
import { computeOverall, currentStreakValue } from '../lib/stats';
import { appendRound, getStreakBeforeNext, loadRounds } from '../lib/storage';
import { formatZoned, useTimeZone } from '../lib/timezone';
import {
  PLAY_MODE_LABELS,
  SAMPLING_LABELS,
  SYMBOL_META,
  TIMEFRAME_LABELS,
  type Bar,
  type Direction,
  type PlayMode,
  type RoundContext,
  type RoundRecord,
  type Timeframe,
} from '../lib/types';
import { VOL_LABELS } from '../lib/volatility';

type Phase = 'idle' | 'deciding' | 'revealed';

type PlayResult = {
  correct: boolean | null;
  predicted: Direction;
  actual: Direction | null;
  nextBar: Bar | null;
  nextBarEnd: number;
  outcome?: 'tp' | 'sl' | 'unresolved';
  entry?: number;
  takeProfit?: number;
  stopLoss?: number;
  distance?: number;
  barsToHit?: number | null;
  hitTime?: number | null;
};

export function PlayPage() {
  const nav = useNavigate();
  const location = useLocation();
  const settings = loadSettings();
  const [timeZone] = useTimeZone();
  const mode: PlayMode = settings.mode === 'bracket' ? 'bracket' : 'direction';
  const [chartTf, setChartTf] = useState<Timeframe>(settings.playTf);
  const [bars, setBars] = useState<Bar[]>([]);
  const [ctx, setCtx] = useState<RoundContext | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [bracket, setBracket] = useState<{ direction: Direction; distance: number } | null>(null);
  const [result, setResult] = useState<PlayResult | null>(null);
  const [flash, setFlash] = useState(false);
  const [statsSnap, setStatsSnap] = useState(() => summarize(mode));
  const startedAt = useRef(0);
  const chartTfRef = useRef(chartTf);
  const autoStarted = useRef(false);
  const actionLock = useRef(false);
  const barsRef = useRef(bars);
  const barsTfRef = useRef<Timeframe | null>(null);
  const samplingSessionRef = useRef(settings.samplingSessionId);

  chartTfRef.current = chartTf;
  barsRef.current = bars;

  /** Active censor boundary: before answer = cutoff; after = end of revealed bar. */
  const censorAt = (c: RoundContext, r: PlayResult | null): number | null => {
    if (!c) return null;
    if (r) return r.nextBarEnd;
    return c.cutoff;
  };

  const reloadChart = useCallback(
    async (c: RoundContext, r: PlayResult | null, tf: Timeframe) => {
      const cutoff = censorAt(c, r);
      const extend = mode === 'bracket' && r != null && barsTfRef.current === tf;
      const data = await fetchBars({
        symbol: settings.symbol,
        tf,
        cutoff,
        limit: extend ? 8000 : 400,
      });
      if (extend) {
        const prev = barsRef.current;
        const prevLast = prev[prev.length - 1]?.t;
        let incoming = data;
        if (prevLast != null && data.length && data[0].t > prevLast) {
          const gap = await fetchBars({
            symbol: settings.symbol,
            tf,
            cutoff,
            after: prevLast,
            limit: 8000,
          });
          incoming = mergeBars(data, gap);
        }
        setBars(mergeBars(prev, incoming));
      } else {
        setBars(data);
      }
      barsTfRef.current = tf;
    },
    [settings.symbol, mode],
  );

  const startRound = useCallback(async () => {
    if (actionLock.current) return;
    actionLock.current = true;
    setError(null);
    setResult(null);
    setBracket(null);
    setFlash(false);
    setPhase('idle');
    try {
      const sampling = settings.sampling === 'balanced' ? 'balanced' : 'random';
      let samplingSessionId = samplingSessionRef.current;
      if (sampling === 'balanced' && !samplingSessionId) {
        samplingSessionId = crypto.randomUUID();
        samplingSessionRef.current = samplingSessionId;
        saveSettings({ ...loadSettings(), samplingSessionId });
      }
      const round = await nextRound(settings.symbol, settings.playTf, settings.filters, mode, {
        sampling,
        atrMultiple: settings.bracketAtrMultiple,
        samplingSessionId,
      });
      setCtx(round);
      if (mode === 'bracket') {
        const multiple = round.defaultAtrMultiple ?? shownAtrMultiple(settings, null);
        setBracket({ direction: 'up', distance: defaultBracketDistance(round.atr, round.minDistance, multiple) });
      }
      startedAt.current = performance.now();
      await reloadChart(round, null, chartTfRef.current);
      setPhase('deciding');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    } finally {
      actionLock.current = false;
    }
  }, [settings, reloadChart, mode]);

  useEffect(() => {
    const st = location.state as { autoStart?: boolean } | null;
    if (st?.autoStart && !autoStarted.current) {
      autoStarted.current = true;
      void startRound();
    }
  }, [location.state, startRound]);

  useEffect(() => {
    if (!ctx) return;
    void reloadChart(ctx, result, chartTf).catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [chartTf, ctx, result, reloadChart]);

  const answer = useCallback(
    async (predicted: Direction) => {
      if (!ctx || phase !== 'deciding' || actionLock.current) return;
      actionLock.current = true;
      const tfAtAnswer = chartTfRef.current;
      try {
        const res = await revealRound(ctx.roundId, predicted);
        const nextBarEnd = res.meta.nextBarEnd as number;
        const revealed = {
          correct: res.correct,
          predicted: res.predicted,
          actual: res.actual,
          nextBar: res.nextBar,
          nextBarEnd,
        };
        setResult(revealed);
        const streakBefore = getStreakBeforeNext(mode);
        await appendRound({
          id: ctx.roundId,
          playedAt: Date.now(),
          symbol: settings.symbol,
          playTf: settings.playTf,
          chartTf: tfAtAnswer,
          mode: 'direction',
          predicted: res.predicted,
          actual: res.actual,
          correct: res.correct,
          skipped: false,
          cutoff: res.meta.cutoff,
          nextOpen: res.nextBar.o,
          nextHigh: res.nextBar.h,
          nextLow: res.nextBar.l,
          nextClose: res.nextBar.c,
          session: res.meta.session as RoundRecord['session'],
          dayOfWeek: res.meta.dayOfWeek,
          hour: res.meta.hour,
          barRange: res.meta.barRange,
          rangeBucket: res.meta.rangeBucket as RoundRecord['rangeBucket'],
          volBucket: res.meta.volBucket as RoundRecord['volBucket'],
          streakBefore,
          timeToAnswerMs: Math.round(performance.now() - startedAt.current),
        });
        setStatsSnap(summarize(mode));
        await reloadChart(ctx, revealed, tfAtAnswer);
        setFlash(true);
        setPhase('revealed');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        actionLock.current = false;
      }
    },
    [ctx, phase, settings, reloadChart, mode],
  );

  const confirmBracket = useCallback(async () => {
    if (!ctx || !bracket || phase !== 'deciding' || mode !== 'bracket' || actionLock.current) return;
    actionLock.current = true;
    const tfAtAnswer = chartTfRef.current;
    const submitted = bracket;
    try {
      const res = await revealBracket(ctx.roundId, submitted.direction, submitted.distance);
      const revealed: PlayResult = {
        correct: res.correct,
        predicted: res.direction,
        actual: res.actual,
        nextBar: res.hitBar,
        nextBarEnd: res.revealUntil,
        outcome: res.outcome,
        entry: res.entry,
        takeProfit: res.takeProfit,
        stopLoss: res.stopLoss,
        distance: res.distance,
        barsToHit: res.barsToHit,
        hitTime: res.hitTime,
      };
      setResult(revealed);
      const streakBefore = getStreakBeforeNext(mode);
      await appendRound({
        id: ctx.roundId,
        playedAt: Date.now(),
        symbol: settings.symbol,
        playTf: settings.playTf,
        chartTf: tfAtAnswer,
        mode: 'bracket',
        predicted: res.direction,
        actual: res.actual,
        correct: res.correct,
        skipped: false,
        outcome: res.outcome,
        entry: res.entry,
        takeProfit: res.takeProfit,
        stopLoss: res.stopLoss,
        distance: res.distance,
        atr: res.atr,
        barsToHit: res.barsToHit,
        cutoff: res.meta.cutoff,
        nextOpen: res.hitBar?.o ?? 0,
        nextHigh: res.hitBar?.h ?? 0,
        nextLow: res.hitBar?.l ?? 0,
        nextClose: res.hitBar?.c ?? 0,
        session: res.meta.session,
        dayOfWeek: res.meta.dayOfWeek,
        hour: res.meta.hour,
        barRange: res.meta.barRange,
        rangeBucket: null,
        volBucket: res.meta.volBucket,
        streakBefore,
        timeToAnswerMs: Math.round(performance.now() - startedAt.current),
      });
      setStatsSnap(summarize(mode));
      await reloadChart(ctx, revealed, tfAtAnswer);
      setFlash(true);
      setPhase('revealed');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      actionLock.current = false;
    }
  }, [ctx, bracket, phase, mode, settings, reloadChart]);

  const nudgeBracket = useCallback(
    (ticks: number) => {
      if (!ctx || phase !== 'deciding') return;
      setBracket((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          distance: snapDistance(prev.distance + ticks * PRICE_TICK, ctx.minDistance, PRICE_TICK),
        };
      });
    },
    [ctx, phase],
  );

  const skipQuestion = useCallback(async () => {
    if (!ctx || phase !== 'deciding' || actionLock.current) return;
    actionLock.current = true;
    const tfAtSkip = chartTfRef.current;
    try {
      const streakBefore = getStreakBeforeNext(mode);
      await appendRound({
        id: ctx.roundId,
        playedAt: Date.now(),
        symbol: settings.symbol,
        playTf: settings.playTf,
        chartTf: tfAtSkip,
        mode,
        predicted: null,
        actual: null,
        correct: null,
        skipped: true,
        cutoff: ctx.cutoff,
        nextOpen: 0,
        nextHigh: 0,
        nextLow: 0,
        nextClose: 0,
        session: ctx.session,
        dayOfWeek: ctx.dayOfWeek,
        hour: ctx.hour,
        barRange: 0,
        rangeBucket: null,
        volBucket: ctx.volBucket,
        streakBefore,
        timeToAnswerMs: Math.round(performance.now() - startedAt.current),
      });
      setStatsSnap(summarize(mode));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      actionLock.current = false;
    }
    await startRound();
  }, [ctx, phase, settings, startRound, mode]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (phase === 'deciding' && mode === 'bracket') {
        if (e.code === 'ArrowUp' || e.code === 'KeyW') {
          e.preventDefault();
          setBracket((prev) => (prev ? { ...prev, direction: 'up' } : prev));
        } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
          e.preventDefault();
          setBracket((prev) => (prev ? { ...prev, direction: 'down' } : prev));
        } else if ((e.code === 'Equal' || e.code === 'NumpadAdd') && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          nudgeBracket(1);
        } else if ((e.code === 'Minus' || e.code === 'NumpadSubtract') && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          nudgeBracket(-1);
        } else if (e.code === 'Enter') {
          e.preventDefault();
          void confirmBracket();
        } else if (e.code === 'KeyX' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          void skipQuestion();
        }
      } else if (phase === 'deciding') {
        if (e.code === 'ArrowUp' || e.code === 'KeyW') {
          e.preventDefault();
          void answer('up');
        } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
          e.preventDefault();
          void answer('down');
        } else if (e.code === 'KeyX' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          void skipQuestion();
        }
      } else if (phase === 'revealed') {
        if (e.code === 'Enter' || e.code === 'Space') {
          e.preventDefault();
          void startRound();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, mode, answer, skipQuestion, startRound, confirmBracket, nudgeBracket]);

  const onNeedMore = useCallback(
    async (oldest: number) => {
      if (!ctx) return;
      const cutoff = censorAt(ctx, result);
      const older = await fetchBars({
        symbol: settings.symbol,
        tf: chartTf,
        before: oldest,
        cutoff,
        limit: 400,
      });
      if (!older.length) return;
      setBars((prev) => {
        const map = new Map<number, Bar>();
        for (const b of older) map.set(b.t, b);
        for (const b of prev) map.set(b.t, b);
        return [...map.values()].sort((a, b) => a.t - b.t);
      });
    },
    [ctx, result, settings.symbol, chartTf],
  );

  const live =
    mode === 'bracket' && ctx && bracket ? makeBracket(ctx.lastBar.c, bracket.direction, bracket.distance) : null;

  const chartBracket: ChartBracket | null = (() => {
    if (mode !== 'bracket' || !ctx || phase === 'idle') return null;
    if (
      phase === 'revealed' &&
      result?.entry != null &&
      result.takeProfit != null &&
      result.stopLoss != null
    ) {
      const hit = result.outcome === 'tp' || result.outcome === 'sl' ? result.outcome : null;
      return {
        entry: result.entry,
        takeProfit: result.takeProfit,
        stopLoss: result.stopLoss,
        atr: ctx.atr,
        minDistance: ctx.minDistance,
        interactive: false,
        hit,
      };
    }
    if (!live || phase !== 'deciding') return null;
    return {
      entry: live.entry,
      takeProfit: live.takeProfit,
      stopLoss: live.stopLoss,
      atr: ctx.atr,
      minDistance: ctx.minDistance,
      interactive: true,
      hit: null,
    };
  })();

  const onBracketChange = useCallback((next: Bracket) => {
    setBracket({ direction: next.direction, distance: next.distance });
  }, []);

  const watermark =
    ctx && phase === 'deciding'
      ? mode === 'bracket'
        ? `止盈止损 · 拖动水平线 · 截止 ${formatZoned(ctx.cutoff, timeZone)}`
        : `预测模式 · 数据截止 ${formatZoned(ctx.cutoff, timeZone)}`
      : ctx && phase === 'revealed'
        ? `已揭晓 · 目标 ${formatZoned(ctx.cutoff, timeZone)}`
        : undefined;

  return (
    <div className="page-wide play-page">
      <div className="chart-layout">
        <div className="panel chart-toolbar">
          <strong style={{ fontSize: 13 }}>
            {SYMBOL_META[settings.symbol].fullName} / {settings.symbol}
          </strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {PLAY_MODE_LABELS[mode]} · {TIMEFRAME_LABELS[settings.playTf]}
            {settings.sampling === 'balanced' ? ` · ${SAMPLING_LABELS.balanced}` : ''}
          </span>
          <TimeframeBar value={chartTf} onChange={setChartTf} />
          <span className="num toolbar-stats">
            胜率{' '}
            <b className={statsSnap.rate >= 0.5 ? 'up' : 'down'}>
              {(statsSnap.rate * 100).toFixed(1)}%
            </b>
            <span className="muted">
              {' '}
              ({statsSnap.wins}/{statsSnap.answered})
            </span>
            <span className="skip"> · 跳过 {statsSnap.skips}</span>
            {statsSnap.unresolved > 0 ? (
              <span className="skip"> · 未触及 {statsSnap.unresolved}</span>
            ) : null}
            {statsSnap.streak !== 0 ? (
              <span className={statsSnap.streak > 0 ? 'up' : 'down'}>
                {' '}
                · {statsSnap.streak > 0 ? `连胜${statsSnap.streak}` : `连败${-statsSnap.streak}`}
              </span>
            ) : null}
          </span>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}
        <CandleChart
          bars={bars}
          watermark={watermark}
          flashLast={flash}
          onNeedMoreHistory={onNeedMore}
          bracket={chartBracket}
          onBracketChange={onBracketChange}
          anchorTime={mode === 'bracket' && ctx ? maxVisibleOpen(chartTf, ctx.cutoff, bars) : null}
        />

        <div className="play-footer">
          <section className="panel decision">
            {phase === 'idle' ? (
              <>
                {!ctx ? (
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                    {mode === 'bracket'
                      ? `点击开始后进入历史某一时刻。止盈和止损等距，初始 ${shownAtrMultiple(settings, ctx)}×ATR，且不小于 1×ATR。先碰到止盈算赢，先碰到止损算输。`
                      : settings.sampling === 'balanced'
                        ? '点击开始后进入历史某一时刻。本局下一根涨和跌各占一半，顺序已打乱。拿不准可以跳过，次数不限。'
                        : '点击开始后将随机跳转到历史某一时刻，请根据截止前的走势判断下一根预测周期K线方向。拿不准可以跳过，次数不限。'}
                  </p>
                ) : null}
                <button type="button" className="btn btn-primary" onClick={() => void startRound()}>
                  {ctx ? '下一题' : '开始本局'}
                </button>
              </>
            ) : null}

            {ctx && phase === 'deciding' && mode === 'direction' ? (
              <>
                <div className="ctx-row">
                  <span>
                    截止 <b>{formatZoned(ctx.cutoff, timeZone)}</b>
                  </span>
                  <span>
                    昨收 <b className="num">{ctx.lastBar.c.toFixed(2)}</b>
                  </span>
                  <span>
                    ATR <b className="num">{ctx.atr.toFixed(2)}</b>
                    <span className="muted">
                      {' '}
                      ({(ctx.atrPct * 100).toFixed(3)}% · {VOL_LABELS[ctx.volBucket]})
                    </span>
                  </span>
                  <span>
                    近20根涨跌{' '}
                    <b className={`num ${ctx.recentReturn >= 0 ? 'up' : 'down'}`}>
                      {(ctx.recentReturn * 100).toFixed(2)}%
                    </b>
                  </span>
                  <span>
                    时段 <b>{SESSION_LABELS[ctx.session]}</b>
                  </span>
                </div>
                <div className="decision-actions">
                  <div className="decision-btns">
                    <button type="button" className="btn btn-up" onClick={() => void answer('up')}>
                      涨
                    </button>
                    <button type="button" className="btn btn-down" onClick={() => void answer('down')}>
                      跌
                    </button>
                  </div>
                  <button type="button" className="btn btn-skip" onClick={() => void skipQuestion()}>
                    跳过
                  </button>
                </div>
                <span className="muted hint kbd-hint">
                  快捷键 <span className="kbd">↑</span> 涨 · <span className="kbd">↓</span> 跌 ·{' '}
                  <span className="kbd">X</span> 跳过（次数不限）
                </span>
              </>
            ) : null}

            {ctx && phase === 'deciding' && mode === 'bracket' && bracket && live ? (
              <>
                <div className="ctx-row">
                  <span>
                    截止 <b>{formatZoned(ctx.cutoff, timeZone)}</b>
                  </span>
                  <span>
                    入场 <b className="num">{live.entry.toFixed(2)}</b>
                  </span>
                  <span className="up">
                    止盈 <b className="num">{live.takeProfit.toFixed(2)}</b>
                  </span>
                  <span className="down">
                    止损 <b className="num">{live.stopLoss.toFixed(2)}</b>
                  </span>
                  <span>
                    距离 <b className="num">{live.distance.toFixed(2)}</b>
                    <span className="muted">
                      {' '}
                      {formatAtrMultiple(live.distance, ctx.atr)}
                      {live.distance <= ctx.minDistance + 1e-6 ? ' · 最小 1×ATR' : ''}
                    </span>
                  </span>
                  <span>
                    ATR <b className="num">{ctx.atr.toFixed(2)}</b>
                    <span className="muted"> · {VOL_LABELS[ctx.volBucket]}</span>
                  </span>
                </div>
                <div className="decision-actions">
                  <div className="decision-btns">
                    <button
                      type="button"
                      className={bracket.direction === 'up' ? 'btn btn-up' : 'btn'}
                      onClick={() => setBracket((prev) => (prev ? { ...prev, direction: 'up' } : prev))}
                    >
                      做多
                    </button>
                    <button
                      type="button"
                      className={bracket.direction === 'down' ? 'btn btn-down' : 'btn'}
                      onClick={() => setBracket((prev) => (prev ? { ...prev, direction: 'down' } : prev))}
                    >
                      做空
                    </button>
                  </div>
                  <div className="distance-stepper">
                    <StepButton
                      symbol="−"
                      label="缩小距离"
                      disabled={live.distance <= ctx.minDistance + 1e-6}
                      onStep={() => nudgeBracket(-1)}
                    />
                    <span className="distance-stepper-label">
                      距离 <b className="num">{live.distance.toFixed(2)}</b>
                    </span>
                    <StepButton symbol="+" label="增大距离" onStep={() => nudgeBracket(1)} />
                  </div>
                  <button type="button" className="btn btn-primary btn-block" onClick={() => void confirmBracket()}>
                    确认{bracket.direction === 'up' ? '做多' : '做空'}
                  </button>
                  <button type="button" className="btn btn-skip" onClick={() => void skipQuestion()}>
                    跳过
                  </button>
                </div>
                <span className="muted hint kbd-hint">
                  拖动图上的止盈或止损线，另一条保持等距。拖过入场价会反向。快捷键{' '}
                  <span className="kbd">↑</span> 做多 · <span className="kbd">↓</span> 做空 ·{' '}
                  <span className="kbd">+</span>/<span className="kbd">−</span> 调整距离 ·{' '}
                  <span className="kbd">Enter</span> 确认 · <span className="kbd">X</span> 跳过
                </span>
                <span className="muted hint touch-hint">
                  拖动图上的圆点或水平线调整距离，另一条保持等距。拖过入场价会反向。
                </span>
              </>
            ) : null}

            {phase === 'revealed' && result?.outcome ? (
              <>
                <div
                  className={`result-banner ${
                    result.outcome === 'unresolved' ? 'open' : result.correct ? 'ok' : 'bad'
                  }`}
                >
                  {result.outcome === 'unresolved'
                    ? `未触及 · ${result.predicted === 'up' ? '做多' : '做空'} · ${BRACKET_MAX_BARS} 根内没有碰到止盈或止损`
                    : `${result.correct ? '正确' : '错误'} · ${result.predicted === 'up' ? '做多' : '做空'} · 先碰到${
                        result.outcome === 'tp' ? '止盈' : '止损'
                      }${result.barsToHit != null ? ` · 第 ${result.barsToHit} 根` : ''}`}
                  {result.entry != null && result.takeProfit != null && result.stopLoss != null ? (
                    <span className="num" style={{ fontWeight: 500 }}>
                      {' '}
                      入场 {result.entry.toFixed(2)} 止盈 {result.takeProfit.toFixed(2)} 止损{' '}
                      {result.stopLoss.toFixed(2)}
                      {result.hitTime != null ? ` · 触及 ${formatZoned(result.hitTime, timeZone)}` : ''}
                    </span>
                  ) : null}
                  {result.nextBar ? (
                    <span className="num" style={{ fontWeight: 500 }}>
                      {' '}
                      O {result.nextBar.o} H {result.nextBar.h} L {result.nextBar.l} C {result.nextBar.c}
                    </span>
                  ) : null}
                </div>
                <div className="result-actions">
                  <button type="button" className="btn btn-primary" onClick={() => void startRound()}>
                    下一题
                  </button>
                  <button type="button" className="btn" onClick={() => nav('/stats')}>
                    结束本局
                  </button>
                  <Link className="btn btn-ghost" to="/">
                    返回设置
                  </Link>
                </div>
                <span className="muted hint kbd-hint">
                  <span className="kbd">Enter</span> / <span className="kbd">Space</span> 下一题
                </span>
              </>
            ) : null}

            {phase === 'revealed' && result && !result.outcome ? (
              <>
                <div className={`result-banner ${result.correct ? 'ok' : 'bad'}`}>
                  {result.correct ? '正确' : '错误'} · 预测
                  {result.predicted === 'up' ? '涨' : '跌'} · 实际
                  {result.actual === 'up' ? '涨' : '跌'}{' '}
                  {result.nextBar ? (
                    <span className="num" style={{ fontWeight: 500 }}>
                      O {result.nextBar.o} H {result.nextBar.h} L {result.nextBar.l} C {result.nextBar.c}
                    </span>
                  ) : null}
                </div>
                <div className="result-actions">
                  <button type="button" className="btn btn-primary" onClick={() => void startRound()}>
                    下一题
                  </button>
                  <button type="button" className="btn" onClick={() => nav('/stats')}>
                    结束本局
                  </button>
                  <Link className="btn btn-ghost" to="/">
                    返回设置
                  </Link>
                </div>
                <span className="muted hint kbd-hint">
                  <span className="kbd">Enter</span> / <span className="kbd">Space</span> 下一题
                </span>
              </>
            ) : null}
          </section>

          <section className="panel decision round-info">
            <h2 style={{ marginBottom: 4 }}>本局信息</h2>
            <div className="ctx-row">
              <span>
                模式 <b>{PLAY_MODE_LABELS[mode]}</b>
              </span>
              <span>
                品种 <b>{settings.symbol}</b>
              </span>
              <span>
                预测周期 <b>{TIMEFRAME_LABELS[settings.playTf]}</b>
              </span>
              <span>
                出题 <b>{settings.sampling === 'balanced' ? SAMPLING_LABELS.balanced : SAMPLING_LABELS.random}</b>
              </span>
              {mode === 'bracket' ? (
                <span>
                  默认距离 <b className="num">{shownAtrMultiple(settings, ctx)}×ATR</b>
                </span>
              ) : null}
              <span>
                图表周期 <b>{TIMEFRAME_LABELS[chartTf]}</b>
              </span>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.55 }}>
              {mode === 'bracket'
                ? `入场价是截止时刻最后一根已收盘K线的收盘价。止盈和止损相对入场价等距，距离不小于 ATR(14)（向上取整到最小跳动 ${PRICE_TICK}）。之后的 1 分钟走势先碰到止盈算赢，先碰到止损算输；同一根 1 分钟里两边都碰到时，阳线按先下后上、阴线按先上后下。${BRACKET_MAX_BARS} 根预测周期K线内都没碰到则记为未触及，不计胜负。跳过不揭晓、不计胜负。`
                : '涨 = 收盘 > 开盘；十字星已排除。对局中所有周期数据截止于目标K线开盘时刻 T，揭晓后放宽至该K线收盘。图表周期与预测周期相互独立。跳过不揭晓答案、不计胜负，可无限使用，并记入统计。'}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

function StepButton({
  symbol,
  label,
  onStep,
  disabled,
}: {
  symbol: string;
  label: string;
  onStep: () => void;
  disabled?: boolean;
}) {
  const timers = useRef<number[]>([]);
  const onStepRef = useRef(onStep);
  const held = useRef(false);
  onStepRef.current = onStep;

  const clear = () => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  };

  useEffect(() => clear, []);

  return (
    <button
      type="button"
      className="btn step-btn"
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        if (held.current) return;
        onStepRef.current();
      }}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        held.current = true;
        onStepRef.current();
        const arm = window.setTimeout(() => {
          const tick = () => {
            onStepRef.current();
            timers.current.push(window.setTimeout(tick, 48));
          };
          timers.current.push(window.setTimeout(tick, 48));
        }, 340);
        timers.current.push(arm);
      }}
      onPointerUp={() => {
        clear();
        window.setTimeout(() => {
          held.current = false;
        }, 0);
      }}
      onPointerCancel={() => {
        clear();
        held.current = false;
      }}
    >
      {symbol}
    </button>
  );
}

function mergeBars(prev: Bar[], next: Bar[]): Bar[] {
  if (!prev.length) return next;
  if (!next.length) return prev;
  const map = new Map<number, Bar>();
  for (const bar of prev) map.set(bar.t, bar);
  for (const bar of next) map.set(bar.t, bar);
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function shownAtrMultiple(
  settings: { sampling: string; bracketAtrMultiple: number },
  ctx: { defaultAtrMultiple?: number } | null,
): number {
  if (ctx?.defaultAtrMultiple != null) return ctx.defaultAtrMultiple;
  return settings.sampling === 'balanced' ? settings.bracketAtrMultiple : DEFAULT_BRACKET_ATR_MULTIPLE;
}

function summarize(mode: PlayMode) {
  const rounds = loadRounds().filter((r) => (r.mode ?? 'direction') === mode);
  const overall = computeOverall(rounds);
  return {
    answered: overall.answered,
    wins: overall.wins,
    skips: overall.skips,
    unresolved: overall.unresolved,
    rate: overall.winRate,
    streak: currentStreakValue(rounds),
  };
}
