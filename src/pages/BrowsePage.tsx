import { useCallback, useEffect, useRef, useState } from 'react';
import { CandleChart } from '../components/CandleChart';
import { TimeframeBar } from '../components/TimeframeBar';
import { fetchBars, fetchHealth } from '../lib/api';
import {
  SYMBOL_META,
  type Bar,
  type SymbolId,
  type Timeframe,
} from '../lib/types';

export function BrowsePage() {
  const [symbol, setSymbol] = useState<SymbolId>('ES');
  const [tf, setTf] = useState<Timeframe>('5m');
  const [bars, setBars] = useState<Bar[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Bumped per symbol/tf load; responses from an older one are dropped. */
  const loadSeq = useRef(0);

  const loadTail = useCallback(async (sym: SymbolId, timeframe: Timeframe) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const h = await fetchHealth();
      if (!h.ok) throw new Error(h.error || '数据未就绪');
      const data = await fetchBars({ symbol: sym, tf: timeframe, limit: 800 });
      if (seq === loadSeq.current) setBars(data);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setBars([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTail(symbol, tf);
  }, [symbol, tf, loadTail]);

  const onNeedMore = useCallback(
    async (oldest: number) => {
      const seq = loadSeq.current;
      try {
        const older = await fetchBars({
          symbol,
          tf,
          before: oldest,
          limit: 500,
        });
        if (seq !== loadSeq.current || !older.length) return;
        setBars((prev) => {
          const map = new Map<number, Bar>();
          for (const b of older) map.set(b.t, b);
          for (const b of prev) map.set(b.t, b);
          return [...map.values()].sort((a, b) => a.t - b.t);
        });
      } catch {
        /* ignore pan-load errors */
      }
    },
    [symbol, tf],
  );

  return (
    <div className="page-wide browse-page">
      <div className="chart-layout">
        <div className="panel chart-toolbar">
          <select value={symbol} onChange={(e) => setSymbol(e.target.value as SymbolId)}>
            {(Object.keys(SYMBOL_META) as SymbolId[]).map((id) => (
              <option key={id} value={id}>
                {SYMBOL_META[id].fullName} / {id}
              </option>
            ))}
          </select>
          <TimeframeBar value={tf} onChange={setTf} />
          <span className="muted" style={{ fontSize: 12 }}>
            浏览模式 · 完整历史 · {loading ? '加载中…' : `${bars.length} 根已载入`}
          </span>
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        <CandleChart bars={bars} onNeedMoreHistory={onNeedMore} />
      </div>
    </div>
  );
}
