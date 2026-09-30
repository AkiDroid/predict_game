import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type AutoscaleInfo,
  type CandlestickData,
  type HistogramData,
  type Logical,
  type Time,
  type Coordinate,
  createChart,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { bracketFromPointer, formatAtrMultiple, PRICE_TICK, type Bracket } from '../lib/bracket';
import type { Bar } from '../lib/types';
import {
  barIndexByTime,
  chartViewportAction,
  logicalRangeForAnchor,
  pinViewportPlan,
} from './chartViewport';

const UP = '#26a69a';
const DOWN = '#ef5350';
const HIT_PX = 12;

function toCandle(b: Bar): CandlestickData<Time> {
  return {
    time: b.t as Time,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
  };
}

function toVol(b: Bar): HistogramData<Time> {
  return {
    time: b.t as Time,
    value: b.v,
    color: b.c >= b.o ? 'rgba(38,166,154,0.45)' : 'rgba(239,83,80,0.45)',
  };
}

export interface ChartBracket {
  entry: number;
  takeProfit: number;
  stopLoss: number;
  atr: number;
  minDistance: number;
  interactive: boolean;
  hit: 'tp' | 'sl' | null;
}

export interface CandleChartProps {
  bars: Bar[];
  flashLast?: boolean;
  watermark?: string;
  onNeedMoreHistory?: (oldestTime: number) => void;
  bracket?: ChartBracket | null;
  onBracketChange?: (next: Bracket) => void;
  /**
   * Open time of the decision bar in bracket mode. Bars after it reveal the
   * answer and must not move or rescale the chart. Null in direction mode.
   */
  anchorTime?: number | null;
}

interface Overlay {
  entryY: number | null;
  tpY: number | null;
  slY: number | null;
  width: number;
  entry: number;
  takeProfit: number;
  stopLoss: number;
}

interface Lines {
  entry: IPriceLine;
  tp: IPriceLine;
  sl: IPriceLine;
}

export function CandleChart({
  bars,
  flashLast,
  watermark,
  onNeedMoreHistory,
  bracket,
  onBracketChange,
  anchorTime = null,
}: CandleChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const linesRef = useRef<Lines | null>(null);
  const barsRef = useRef(bars);
  const onNeedMoreRef = useRef(onNeedMoreHistory);
  const bracketRef = useRef(bracket ?? null);
  const previewRef = useRef<Bracket | null>(null);
  const onDragRef = useRef(onBracketChange);
  const draggingRef = useRef<'tp' | 'sl' | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const syncOverlayRef = useRef<() => void>(() => {});
  const spanRef = useRef<number | null>(null);
  const entryFitRef = useRef<number | null>(null);
  const hitFitRef = useRef<'tp' | 'sl' | null>(null);
  const loadingMore = useRef(false);
  const lastBarTimeRef = useRef<number | null>(null);
  const barsLenRef = useRef(0);
  const anchorTimeRef = useRef<number | null>(null);
  /** Decision bar's x as a fraction of the chart box (plot + price scale). */
  const anchorXFractionRef = useRef<number | null>(null);
  const baseBarSpacingRef = useRef(6);
  const userViewRef = useRef(false);
  const applyingRef = useRef(false);
  const holdPriceRef = useRef(false);
  const captureAnchorRef = useRef<() => void>(() => {});
  const [legend, setLegend] = useState('');
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  barsRef.current = bars;
  onNeedMoreRef.current = onNeedMoreHistory;
  bracketRef.current = bracket ?? null;
  onDragRef.current = onBracketChange;
  anchorTimeRef.current = anchorTime;

  function captureAnchorFraction() {
    const time = anchorTimeRef.current;
    const chart = chartRef.current;
    const series = candleRef.current;
    const seriesBars = barsRef.current;
    if (time == null || !chart || !series || !seriesBars.length) return;
    const idx = barIndexByTime(seriesBars, time);
    if (idx < 0 || idx !== seriesBars.length - 1) return;
    const plot = chart.timeScale().width();
    const axis = series.priceScale().width();
    const total = plot + axis;
    const x = chart.timeScale().logicalToCoordinate(idx as Logical);
    if (x == null || !(plot > 0) || !(total > 0) || !Number.isFinite(x)) return;
    anchorXFractionRef.current = x / total;
  }
  captureAnchorRef.current = captureAnchorFraction;

  function activeLevels(): { entry: number; takeProfit: number; stopLoss: number } | null {
    return previewRef.current ?? bracketRef.current;
  }

  function syncOverlay() {
    const chart = chartRef.current;
    const series = candleRef.current;
    const levels = activeLevels();
    if (!chart || !series || !levels) {
      setOverlay((prev) => (prev === null ? prev : null));
      return;
    }
    const next: Overlay = {
      entryY: coord(series.priceToCoordinate(levels.entry)),
      tpY: coord(series.priceToCoordinate(levels.takeProfit)),
      slY: coord(series.priceToCoordinate(levels.stopLoss)),
      width: chart.timeScale().width(),
      entry: levels.entry,
      takeProfit: levels.takeProfit,
      stopLoss: levels.stopLoss,
    };
    setOverlay((prev) => (sameOverlay(prev, next) ? prev : next));
  }
  syncOverlayRef.current = syncOverlay;

  function yInChart(clientY: number): number | null {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    return clientY - wrap.getBoundingClientRect().top;
  }

  function priceAt(clientY: number): number | null {
    const y = yInChart(clientY);
    const series = candleRef.current;
    if (y == null || !series) return null;
    const price = series.coordinateToPrice(y as Coordinate);
    return price == null || Number.isNaN(price) ? null : price;
  }

  function hitRole(clientY: number): 'tp' | 'sl' | null {
    const live = bracketRef.current;
    const levels = activeLevels();
    const series = candleRef.current;
    if (!live?.interactive || !levels || !series) return null;
    const y = yInChart(clientY);
    if (y == null) return null;
    const yTp = series.priceToCoordinate(levels.takeProfit);
    const ySl = series.priceToCoordinate(levels.stopLoss);
    let best: { role: 'tp' | 'sl'; d: number } | null = null;
    if (yTp != null) {
      const d = Math.abs(y - yTp);
      if (d <= HIT_PX) best = { role: 'tp', d };
    }
    if (ySl != null) {
      const d = Math.abs(y - ySl);
      if (d <= HIT_PX && (!best || d < best.d)) best = { role: 'sl', d };
    }
    return best?.role ?? null;
  }

  function beginDrag(clientY: number): boolean {
    if (draggingRef.current) return true;
    const role = hitRole(clientY);
    if (!role) return false;
    draggingRef.current = role;
    if (containerRef.current) containerRef.current.style.cursor = 'ns-resize';

    const move = (ev: PointerEvent) => {
      if (ev.cancelable) ev.preventDefault();
      const price = priceAt(ev.clientY);
      const live = bracketRef.current;
      if (price == null || !live) return;
      const next = bracketFromPointer(live.entry, price, role, live.minDistance, PRICE_TICK);
      previewRef.current = next;
      linesRef.current?.tp.applyOptions({ price: next.takeProfit });
      linesRef.current?.sl.applyOptions({ price: next.stopLoss });
      if (containerRef.current) containerRef.current.style.cursor = 'ns-resize';
      syncOverlayRef.current();
      onDragRef.current?.(next);
    };
    const up = () => {
      draggingRef.current = null;
      previewRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      dragCleanupRef.current = null;
      candleRef.current?.priceScale().setAutoScale(true);
      requestAnimationFrame(() => syncOverlayRef.current());
    };
    dragCleanupRef.current = up;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    return true;
  }

  useEffect(() => {
    return () => dragCleanupRef.current?.();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#0e1318' },
        textColor: '#8b9bb0',
        fontFamily: 'IBM Plex Mono, Consolas, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(42,53,68,0.55)' },
        horzLines: { color: 'rgba(42,53,68,0.55)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(139,155,176,0.35)', labelBackgroundColor: '#1a222c' },
        horzLine: { color: 'rgba(139,155,176,0.35)', labelBackgroundColor: '#1a222c' },
      },
      rightPriceScale: {
        borderColor: '#2a3544',
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: '#2a3544',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
      },
      localization: { locale: 'zh-CN' },
      autoSize: true,
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const res = original();
        const b = previewRef.current ?? bracketRef.current;
        if (!res?.priceRange || !b) return res;
        const lo = Math.min(b.entry, b.takeProfit, b.stopLoss);
        const hi = Math.max(b.entry, b.takeProfit, b.stopLoss);
        const pad = Math.max((hi - lo) * 0.15, 0);
        return {
          ...res,
          priceRange: {
            minValue: Math.min(res.priceRange.minValue, lo - pad),
            maxValue: Math.max(res.priceRange.maxValue, hi + pad),
          },
        };
      },
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current = chart;
    candleRef.current = candles;
    volRef.current = volume;
    baseBarSpacingRef.current = chart.timeScale().options().barSpacing;

    const armUserView = () => {
      userViewRef.current = true;
    };
    const disarmUserView = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          userViewRef.current = false;
        });
      });
    };
    window.addEventListener('wheel', armUserView, { capture: true, passive: true });
    window.addEventListener('pointerdown', armUserView, { capture: true });
    window.addEventListener('pointerup', disarmUserView);
    window.addEventListener('pointercancel', disarmUserView);

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData.size) {
        const last = barsRef.current[barsRef.current.length - 1];
        if (last) {
          setLegend(
            `O ${fmt(last.o)}  H ${fmt(last.h)}  L ${fmt(last.l)}  C ${fmt(last.c)}  V ${fmtVol(last.v)}`,
          );
        }
        return;
      }
      const c = param.seriesData.get(candles) as CandlestickData<Time> | undefined;
      const v = param.seriesData.get(volume) as HistogramData<Time> | undefined;
      if (c) {
        const cls = c.close >= c.open ? 'up' : 'down';
        setLegend(
          `<span class="${cls}">O ${fmt(c.open)}  H ${fmt(c.high)}  L ${fmt(c.low)}  C ${fmt(c.close)}</span>  V ${fmtVol(v?.value ?? 0)}`,
        );
      }
    });

    const onRange = () => {
      syncOverlayRef.current();
      if (applyingRef.current) return;
      if (userViewRef.current || anchorXFractionRef.current == null) captureAnchorRef.current();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    const ro = new ResizeObserver(() => syncOverlayRef.current());
    ro.observe(el);
    const refresh = () => syncOverlayRef.current();
    el.addEventListener('wheel', refresh, { passive: true });
    el.addEventListener('pointerup', refresh);

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      const loadMore = onNeedMoreRef.current;
      if (!range || !loadMore || loadingMore.current) return;
      if (range.from < 5) {
        const oldest = barsRef.current[0];
        if (oldest) {
          loadingMore.current = true;
          loadMore(oldest.t);
          window.setTimeout(() => {
            loadingMore.current = false;
          }, 400);
        }
      }
    });

    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', refresh);
      el.removeEventListener('pointerup', refresh);
      window.removeEventListener('wheel', armUserView, { capture: true });
      window.removeEventListener('pointerdown', armUserView, { capture: true });
      window.removeEventListener('pointerup', disarmUserView);
      window.removeEventListener('pointercancel', disarmUserView);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      linesRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { shiftVisibleRangeOnNewBar: anchorTime == null },
    });
  }, [anchorTime]);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    const volume = volRef.current;
    if (!candles || !volume || !chart) return;
    let raf = 0;
    const pinnedTime = anchorTimeRef.current;
    const action = chartViewportAction(lastBarTimeRef.current, barsLenRef.current, bars);
    const plan = !bars.length || pinnedTime == null ? action : pinViewportPlan(action);
    holdPriceRef.current = plan === 'hold';
    applyingRef.current = plan === 'hold' || plan === 'rescale' || plan === 'frame';
    const priceSnapshot = plan === 'hold' ? candles.priceScale().getVisibleRange() : null;
    const barSpacing = plan === 'hold' ? chart.timeScale().options().barSpacing : baseBarSpacingRef.current;
    const fraction = anchorXFractionRef.current;
    const anchorIndex = pinnedTime == null ? -1 : barIndexByTime(bars, pinnedTime);

    candles.setData(bars.map(toCandle));
    volume.setData(bars.map(toVol));
    if (bars.length) {
      const last = bars[bars.length - 1];
      setLegend(
        `O ${fmt(last.o)}  H ${fmt(last.h)}  L ${fmt(last.l)}  C ${fmt(last.c)}  V ${fmtVol(last.v)}`,
      );

      const placeAnchor = () => {
        if (chartRef.current !== chart || candleRef.current !== candles) return false;
        if (fraction == null || anchorIndex < 0) return false;
        const plot = chart.timeScale().width();
        const axis = candles.priceScale().width();
        const total = plot + axis;
        if (!(plot > 0) || !(total > 0)) return false;
        const range = logicalRangeForAnchor(anchorIndex, fraction * total, barSpacing, plot);
        if (!range) return false;
        chart.timeScale().setVisibleLogicalRange(range);
        return true;
      };

      if (plan === 'follow') {
        chart.timeScale().scrollToRealTime();
      } else if (plan === 'frame' || (plan === 'rescale' && !placeAnchor())) {
        frameLatestPrice(chart, candles);
      } else if (plan === 'rescale') {
        candles.priceScale().setAutoScale(true);
      } else if (plan === 'hold') {
        if (priceSnapshot) candles.priceScale().setVisibleRange(priceSnapshot);
        placeAnchor();
      }

      const framed = bars;
      raf = requestAnimationFrame(() => {
        const alive = candleRef.current === candles && chartRef.current === chart;
        if (alive && plan === 'hold') {
          if (priceSnapshot) candles.priceScale().setVisibleRange(priceSnapshot);
          placeAnchor();
        } else if (alive && plan === 'rescale' && fraction != null && anchorIndex >= 0) {
          placeAnchor();
          const price = candles.priceScale().getVisibleRange();
          const tail = framed[framed.length - 1];
          if (!price || tail.l < price.from || tail.h > price.to) {
            candles.priceScale().setAutoScale(true);
          }
        } else if (alive && (plan === 'frame' || plan === 'rescale')) {
          const price = candles.priceScale().getVisibleRange();
          const tail = framed[framed.length - 1];
          if (tail && (!price || tail.l < price.from || tail.h > price.to)) {
            frameLatestPrice(chart, candles);
          }
        }
        lastBarTimeRef.current = framed[framed.length - 1].t;
        barsLenRef.current = framed.length;
        applyingRef.current = false;
        if (alive && anchorXFractionRef.current == null) captureAnchorRef.current();
        if (alive) syncOverlayRef.current();
      });
    } else {
      holdPriceRef.current = false;
      raf = requestAnimationFrame(() => {
        lastBarTimeRef.current = null;
        barsLenRef.current = 0;
        applyingRef.current = false;
      });
    }
    syncOverlayRef.current();
    return () => {
      cancelAnimationFrame(raf);
      applyingRef.current = false;
    };
  }, [bars]);

  useEffect(() => {
    if (!flashLast || !candleRef.current || bars.length === 0) return;
    const last = bars[bars.length - 1];
    let n = 0;
    const id = window.setInterval(() => {
      n++;
      candleRef.current?.update(toCandle(last));
      if (n > 8) clearInterval(id);
    }, 70);
    return () => clearInterval(id);
  }, [flashLast, bars]);

  const bEntry = bracket?.entry;
  const bTp = bracket?.takeProfit;
  const bSl = bracket?.stopLoss;
  const bHit = bracket?.hit ?? null;
  const bInteractive = bracket?.interactive ?? false;

  useEffect(() => {
    const series = candleRef.current;
    const live = bracketRef.current;
    if (!series) return;
    if (!live || bEntry == null || bTp == null || bSl == null) {
      clearLines(series, linesRef);
      setOverlay(null);
      spanRef.current = null;
      entryFitRef.current = null;
      return;
    }
    if (!draggingRef.current) previewRef.current = null;
    paintLines(series, linesRef, live);
    syncOverlayRef.current();
    if (draggingRef.current) return;
    const span = Math.abs(bTp - bSl);
    const geometryChanged = spanRef.current !== span || entryFitRef.current !== bEntry;
    const hitChanged = hitFitRef.current !== bHit;
    spanRef.current = span;
    entryFitRef.current = bEntry;
    hitFitRef.current = bHit;
    if (holdPriceRef.current) return;
    if (geometryChanged || hitChanged) {
      series.priceScale().setAutoScale(true);
      requestAnimationFrame(() => syncOverlayRef.current());
    }
  }, [bEntry, bTp, bSl, bHit, bInteractive]);

  function claimDrag(e: { button?: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) {
    if (e.button != null && e.button !== 0) return;
    if (!beginDrag(e.clientY)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  const mult = overlay
    ? formatAtrMultiple(Math.abs(overlay.takeProfit - overlay.entry), bracket?.atr ?? 0)
    : '';
  const tpTitle = `${bHit === 'tp' ? '止盈 触及' : '止盈'} ${overlay ? overlay.takeProfit.toFixed(2) : ''} · ${mult}`;
  const slTitle = `${bHit === 'sl' ? '止损 触及' : '止损'} ${overlay ? overlay.stopLoss.toFixed(2) : ''} · ${mult}`;

  return (
    <div
      className="chart-wrap"
      ref={wrapRef}
      onPointerDownCapture={claimDrag}
      onMouseDownCapture={claimDrag}
      onTouchStartCapture={(e) => {
        const touch = e.touches[0];
        if (!touch) return;
        claimDrag({
          clientY: touch.clientY,
          preventDefault: () => e.preventDefault(),
          stopPropagation: () => e.stopPropagation(),
        });
      }}
      onPointerMove={(e) => {
        if (draggingRef.current || !containerRef.current || !bracketRef.current?.interactive) return;
        if (hitRole(e.clientY)) containerRef.current.style.cursor = 'ns-resize';
      }}
    >
      {watermark ? (
        <div className="chart-watermark">
          <span className="badge badge-play">{watermark}</span>
        </div>
      ) : null}
      <div
        className={`ohlc-legend ${watermark ? 'with-badge' : ''}`}
        dangerouslySetInnerHTML={{ __html: legend }}
      />
      <div className="chart-canvas" ref={containerRef} />
      {overlay && overlay.entryY != null && overlay.tpY != null ? (
        <div
          className={`bracket-zone tp${bHit === 'tp' ? ' hit' : ''}`}
          style={zoneStyle(overlay.entryY, overlay.tpY, overlay.width)}
        />
      ) : null}
      {overlay && overlay.entryY != null && overlay.slY != null ? (
        <div
          className={`bracket-zone sl${bHit === 'sl' ? ' hit' : ''}`}
          style={zoneStyle(overlay.entryY, overlay.slY, overlay.width)}
        />
      ) : null}
      {overlay && overlay.tpY != null ? (
        <div className={`bracket-tag up${bHit === 'tp' ? ' hit' : ''}`} style={tagStyle(overlay.tpY, overlay.width)}>
          <span>{tpTitle}</span>
        </div>
      ) : null}
      {overlay && overlay.slY != null ? (
        <div className={`bracket-tag down${bHit === 'sl' ? ' hit' : ''}`} style={tagStyle(overlay.slY, overlay.width)}>
          <span>{slTitle}</span>
        </div>
      ) : null}
    </div>
  );
}

function paintLines(
  series: ISeriesApi<'Candlestick'>,
  linesRef: { current: Lines | null },
  b: ChartBracket,
) {
  const lines = ensureLines(series, linesRef, b);
  const tpHit = b.hit === 'tp';
  const slHit = b.hit === 'sl';
  lines.entry.applyOptions({
    price: b.entry,
    color: '#8b9bb0',
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    title: '入场',
    axisLabelVisible: true,
  });
  lines.tp.applyOptions({
    price: b.takeProfit,
    color: slHit ? 'rgba(38,166,154,0.45)' : UP,
    lineWidth: tpHit ? 3 : 2,
    lineStyle: LineStyle.Solid,
    title: tpHit ? '止盈 触及' : '止盈',
    axisLabelVisible: true,
  });
  lines.sl.applyOptions({
    price: b.stopLoss,
    color: tpHit ? 'rgba(239,83,80,0.45)' : DOWN,
    lineWidth: slHit ? 3 : 2,
    lineStyle: LineStyle.Solid,
    title: slHit ? '止损 触及' : '止损',
    axisLabelVisible: true,
  });
}

function ensureLines(
  series: ISeriesApi<'Candlestick'>,
  linesRef: { current: Lines | null },
  b: ChartBracket,
): Lines {
  if (linesRef.current) return linesRef.current;
  linesRef.current = {
    entry: series.createPriceLine({
      price: b.entry,
      color: '#8b9bb0',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      title: '入场',
      axisLabelVisible: true,
    }),
    tp: series.createPriceLine({
      price: b.takeProfit,
      color: UP,
      lineWidth: 2,
      title: '止盈',
      axisLabelVisible: true,
    }),
    sl: series.createPriceLine({
      price: b.stopLoss,
      color: DOWN,
      lineWidth: 2,
      title: '止损',
      axisLabelVisible: true,
    }),
  };
  return linesRef.current;
}

function clearLines(series: ISeriesApi<'Candlestick'>, linesRef: { current: Lines | null }) {
  const lines = linesRef.current;
  linesRef.current = null;
  if (!lines) return;
  series.removePriceLine(lines.entry);
  series.removePriceLine(lines.tp);
  series.removePriceLine(lines.sl);
}

function coord(v: number | null): number | null {
  return v == null || Number.isNaN(v) ? null : v;
}

function sameOverlay(a: Overlay | null, b: Overlay): boolean {
  if (!a) return false;
  return (
    a.entryY === b.entryY &&
    a.tpY === b.tpY &&
    a.slY === b.slY &&
    a.width === b.width &&
    a.entry === b.entry &&
    a.takeProfit === b.takeProfit &&
    a.stopLoss === b.stopLoss
  );
}

function zoneStyle(a: number, b: number, width: number) {
  return {
    top: Math.min(a, b),
    height: Math.abs(a - b),
    width,
  };
}

function tagStyle(y: number, width: number) {
  return { top: y, width };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtVol(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Snap time zoom and pan to the latest bars, and fit the price scale to that window. */
function frameLatestPrice(chart: IChartApi, series: ISeriesApi<'Candlestick'>) {
  series.priceScale().setAutoScale(true);
  chart.timeScale().resetTimeScale();
}
