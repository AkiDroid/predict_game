import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type AutoscaleInfo,
  type CandlestickData,
  type HistogramData,
  type Logical,
  type MouseEventParams,
  type Time,
  type Coordinate,
  createChart,
} from 'lightweight-charts';
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { bracketFromPointer, formatAtrMultiple, PRICE_TICK, type Bracket } from '../lib/bracket';
import {
  formatOffset,
  formatZoned,
  listTimeZoneOptions,
  useTimeZone,
  zoneOffsetMinutes,
  zoneParts,
} from '../lib/timezone';
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

/** Bars are immutable once fetched, so converted points can be reused across prepends and reveals. */
const seriesPointCache = new WeakMap<Bar, { candle: CandlestickData<Time>; vol: HistogramData<Time> }>();

function toSeriesData(bars: Bar[]): { candles: CandlestickData<Time>[]; vols: HistogramData<Time>[] } {
  const candles = new Array<CandlestickData<Time>>(bars.length);
  const vols = new Array<HistogramData<Time>>(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    let point = seriesPointCache.get(b);
    if (!point) {
      point = { candle: toCandle(b), vol: toVol(b) };
      seriesPointCache.set(b, point);
    }
    candles[i] = point.candle;
    vols[i] = point.vol;
  }
  return { candles, vols };
}

function lastBarLegend(b: Bar): string {
  return `O ${fmt(b.o)}  H ${fmt(b.h)}  L ${fmt(b.l)}  C ${fmt(b.c)}  V ${fmtVol(b.v)}`;
}

interface HoverStore {
  get: () => number | null;
  set: (t: number | null) => void;
  subscribe: (cb: () => void) => () => void;
}

function createHoverStore(): HoverStore {
  let value: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (t) => {
      if (t === value) return;
      value = t;
      for (const cb of listeners) cb();
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const TzReadout = memo(function TzReadout({
  hover,
  lastTime,
  timeZone,
}: {
  hover: HoverStore;
  lastTime: number | null;
  timeZone: string;
}) {
  const hoverTime = useSyncExternalStore(hover.subscribe, hover.get, hover.get);
  const readoutTime = hoverTime ?? lastTime;
  const readoutOffset = formatOffset(zoneOffsetMinutes(timeZone, readoutTime ?? undefined));
  return (
    <>
      <span className="chart-tzbar-time num">{readoutTime != null ? formatZoned(readoutTime, timeZone) : '—'}</span>
      <span className="chart-tzbar-offset num">{readoutOffset}</span>
    </>
  );
});

const TimeZoneSelect = memo(function TimeZoneSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (timeZone: string) => void;
}) {
  const [options] = useState(listTimeZoneOptions);
  return (
    <select
      aria-label="图表时区"
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        e.currentTarget.blur();
      }}
    >
      {options.map((o) => (
        <option key={o.tz} value={o.tz}>
          {o.label}
        </option>
      ))}
    </select>
  );
});

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

export const CandleChart = memo(function CandleChart({
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
  const legendRef = useRef<HTMLDivElement>(null);
  const legendHtmlRef = useRef('');
  const flushCrosshairRef = useRef<() => void>(() => {});
  const [hover] = useState(createHoverStore);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [timeZone, setTimeZone] = useTimeZone();

  function setLegend(html: string) {
    if (legendHtmlRef.current === html) return;
    legendHtmlRef.current = html;
    if (legendRef.current) legendRef.current.innerHTML = html;
  }

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

  function pointInChart(clientX: number, clientY: number): { x: number; y: number } | null {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function priceAt(clientY: number): number | null {
    const pt = pointInChart(0, clientY);
    const series = candleRef.current;
    if (!pt || !series) return null;
    const price = series.coordinateToPrice(pt.y as Coordinate);
    return price == null || Number.isNaN(price) ? null : price;
  }

  function hitRole(clientX: number, clientY: number): 'tp' | 'sl' | null {
    const live = bracketRef.current;
    const levels = activeLevels();
    const series = candleRef.current;
    const pt = pointInChart(clientX, clientY);
    if (!live?.interactive || !levels || !series || !pt) return null;
    const coarse = touchUi();
    const lineSlop = coarse ? 18 : HIT_PX;
    const handleSlop = coarse ? 28 : 0;
    const knobX = Math.max(0, (chartRef.current?.timeScale().width() ?? 0) - 22);
    const score = (price: number) => {
      const yLine = series.priceToCoordinate(price);
      if (yLine == null || Number.isNaN(yLine)) return Number.POSITIVE_INFINITY;
      const dy = Math.abs(pt.y - yLine);
      let best = dy <= lineSlop ? dy : Number.POSITIVE_INFINITY;
      if (handleSlop > 0) {
        const d = Math.hypot(pt.x - knobX, pt.y - yLine);
        if (d <= handleSlop && d < best) best = d;
      }
      return best;
    };
    const tp = score(levels.takeProfit);
    const sl = score(levels.stopLoss);
    if (tp === Number.POSITIVE_INFINITY && sl === Number.POSITIVE_INFINITY) return null;
    return tp <= sl ? 'tp' : 'sl';
  }

  function beginDrag(clientX: number, clientY: number): boolean {
    if (draggingRef.current) return true;
    const role = hitRole(clientX, clientY);
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
    const end = () => {
      draggingRef.current = null;
      previewRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      dragCleanupRef.current = null;
      if (containerRef.current) containerRef.current.style.cursor = '';
      candleRef.current?.priceScale().setAutoScale(true);
      requestAnimationFrame(() => syncOverlayRef.current());
      const swallow = (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      window.addEventListener('click', swallow, true);
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    };
    dragCleanupRef.current = end;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
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
      kineticScroll: { touch: true, mouse: false },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
      },
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

    let crosshairParam: MouseEventParams<Time> | null = null;
    let crosshairRaf = 0;
    const applyCrosshair = () => {
      const param = crosshairParam;
      crosshairParam = null;
      if (crosshairRaf) cancelAnimationFrame(crosshairRaf);
      crosshairRaf = 0;
      if (!param) return;
      hover.set(param.time == null ? null : timeToUnix(param.time));
      if (!param.time || !param.seriesData.size) {
        const last = barsRef.current[barsRef.current.length - 1];
        if (last) setLegend(lastBarLegend(last));
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
    };
    flushCrosshairRef.current = applyCrosshair;
    chart.subscribeCrosshairMove((param) => {
      crosshairParam = param;
      if (!crosshairRaf) crosshairRaf = requestAnimationFrame(applyCrosshair);
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
      if (crosshairRaf) cancelAnimationFrame(crosshairRaf);
      flushCrosshairRef.current = () => {};
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
  }, [hover]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { shiftVisibleRangeOnNewBar: anchorTime == null },
    });
  }, [anchorTime]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time: Time) => formatZoned(timeToUnix(time), timeZone),
      },
      timeScale: {
        tickMarkFormatter: (time: Time, type: TickMarkType) => formatTick(timeToUnix(time), type, timeZone),
      },
    });
  }, [timeZone]);

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

    const data = toSeriesData(bars);
    candles.setData(data.candles);
    volume.setData(data.vols);
    flushCrosshairRef.current();
    if (bars.length) {
      setLegend(lastBarLegend(bars[bars.length - 1]));

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

  function claimDrag(e: {
    button?: number;
    clientX: number;
    clientY: number;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) {
    if (e.button != null && e.button !== 0) return;
    if (!beginDrag(e.clientX, e.clientY)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  const mult = overlay
    ? formatAtrMultiple(Math.abs(overlay.takeProfit - overlay.entry), bracket?.atr ?? 0)
    : '';
  const tpTitle = `${bHit === 'tp' ? '止盈 触及' : '止盈'} ${overlay ? overlay.takeProfit.toFixed(2) : ''} · ${mult}`;
  const slTitle = `${bHit === 'sl' ? '止损 触及' : '止损'} ${overlay ? overlay.stopLoss.toFixed(2) : ''} · ${mult}`;

  const lastTime = bars[bars.length - 1]?.t ?? null;

  return (
    <div
      className={`chart-wrap${bInteractive ? ' is-interactive' : ''}`}
      ref={wrapRef}
      onPointerDownCapture={(e) => {
        if (inTzBar(e.target)) return;
        if (!e.isPrimary) {
          dragCleanupRef.current?.();
          return;
        }
        claimDrag(e);
      }}
      onMouseDownCapture={(e) => {
        if (!inTzBar(e.target)) claimDrag(e);
      }}
      onTouchStartCapture={(e) => {
        if (inTzBar(e.target)) return;
        if (e.touches.length !== 1) {
          dragCleanupRef.current?.();
          return;
        }
        const touch = e.touches[0];
        if (!touch) return;
        claimDrag({
          clientX: touch.clientX,
          clientY: touch.clientY,
          preventDefault: () => e.preventDefault(),
          stopPropagation: () => e.stopPropagation(),
        });
      }}
      onPointerMove={(e) => {
        if (draggingRef.current || !containerRef.current || !bracketRef.current?.interactive) return;
        if (hitRole(e.clientX, e.clientY)) containerRef.current.style.cursor = 'ns-resize';
        else if (!draggingRef.current) containerRef.current.style.cursor = '';
      }}
    >
      {watermark ? (
        <div className="chart-watermark">
          <span className="badge badge-play">{watermark}</span>
        </div>
      ) : null}
      <div className={`ohlc-legend ${watermark ? 'with-badge' : ''}`} ref={legendRef} />
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
      {bInteractive && overlay?.tpY != null ? (
        <div className="bracket-handle up" style={handleStyle(overlay.tpY, overlay.width)} />
      ) : null}
      {bInteractive && overlay?.slY != null ? (
        <div className="bracket-handle down" style={handleStyle(overlay.slY, overlay.width)} />
      ) : null}
      <div className="chart-tzbar">
        <TzReadout hover={hover} lastTime={lastTime} timeZone={timeZone} />
        <label className="chart-tzbar-zone">
          <span className="muted">时区</span>
          <TimeZoneSelect value={timeZone} onChange={setTimeZone} />
        </label>
      </div>
    </div>
  );
});

function inTzBar(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.chart-tzbar') != null;
}

function timeToUnix(time: Time): number {
  if (typeof time === 'number') return time;
  if (typeof time === 'string') return Math.floor(Date.parse(time) / 1000);
  return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Axis tick label in the display zone. Day-level ticks keep the clock when it is not midnight there. */
function formatTick(unixSec: number, type: TickMarkType, timeZone: string): string {
  const p = zoneParts(unixSec, timeZone);
  const clock = `${pad2(p.hour)}:${pad2(p.minute)}`;
  const midnight = p.hour === 0 && p.minute === 0;
  switch (type) {
    case TickMarkType.Year:
      return midnight ? `${p.year}` : `${p.year}/${pad2(p.month)}/${pad2(p.day)} ${clock}`;
    case TickMarkType.Month:
      return midnight ? `${p.year}/${pad2(p.month)}` : `${p.year}/${pad2(p.month)}/${pad2(p.day)} ${clock}`;
    case TickMarkType.DayOfMonth:
      return midnight ? `${pad2(p.month)}/${pad2(p.day)}` : `${pad2(p.month)}/${pad2(p.day)} ${clock}`;
    case TickMarkType.TimeWithSeconds:
      return `${clock}:${pad2(p.second)}`;
    default:
      return clock;
  }
}

function touchUi(): boolean {
  return window.matchMedia('(pointer: coarse), (hover: none)').matches;
}

function handleStyle(y: number, width: number) {
  return { top: y, left: Math.max(0, width - 22) };
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
