import { useMemo, useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { clearRounds, hydrateRounds, loadRounds } from '../lib/storage';
import { computeStats, isSkipped, type SliceStat } from '../lib/stats';
import { TIMEFRAME_LABELS, type PlayMode, type RoundRecord, type SymbolId, type Timeframe } from '../lib/types';
import { formatChicago } from '../lib/time';

export function StatsPage() {
  const [rounds, setRounds] = useState<RoundRecord[]>(() => loadRounds());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filterSym, setFilterSym] = useState<SymbolId | 'all'>('all');
  const [filterTf, setFilterTf] = useState<Timeframe | 'all'>('all');
  const [filterMode, setFilterMode] = useState<PlayMode | 'all'>('all');
  const report = useMemo(() => computeStats(rounds), [rounds]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await hydrateRounds();
        if (!cancelled) {
          setRounds(next);
          setLoadError(null);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    return [...rounds]
      .reverse()
      .filter((r) => (filterSym === 'all' ? true : r.symbol === filterSym))
      .filter((r) => (filterTf === 'all' ? true : r.playTf === filterTf))
      .filter((r) => (filterMode === 'all' ? true : (r.mode ?? 'direction') === filterMode));
  }, [rounds, filterSym, filterTf, filterMode]);

  if (loading) {
    return (
      <div className="page">
        <h1>统计分析</h1>
        <div className="panel empty">正在加载对局记录…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="page">
        <h1>统计分析</h1>
        <div className="error-banner">{loadError}</div>
      </div>
    );
  }

  if (rounds.length === 0) {
    return (
      <div className="page">
        <h1>统计分析</h1>
        <div className="panel empty">
          尚无对局记录。先去{' '}
          <Link to="/">开始游戏</Link>，答题后这里会生成多维分析。
        </div>
      </div>
    );
  }

  const o = report.overall;

  return (
    <div className="page">
      <div className="page-head">
        <h1>统计分析</h1>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            if (confirm('确认清空全部对局记录？')) {
              void clearRounds().then(() => setRounds([]));
            }
          }}
        >
          清空记录
        </button>
      </div>
      <p className="lead">
        基于当前账号在服务端保存的历史对局。胜率与连胜只计已结算的对局；跳过和止盈止损里的「未触及」不计胜负。方向预测与止盈止损可以在「按模式」里分开看。分片作答
        n&lt;30 标记为样本不足；Wilson 区间为近似 95% 置信区间。
      </p>

      <div className="stats-grid">
        <Tile label="总局数" value={String(o.total)} />
        <Tile label="胜 / 负" value={`${o.wins} / ${o.losses}`} />
        <Tile
          label="跳过"
          value={o.total ? `${o.skips} · ${(o.skipRate * 100).toFixed(1)}%` : String(o.skips)}
          tone="warn"
        />
        <Tile label="未触及" value={String(o.unresolved)} tone="warn" />
        <Tile
          label="胜率"
          value={o.answered ? `${(o.winRate * 100).toFixed(1)}%` : '—'}
          tone={o.answered ? (o.winRate >= 0.5 ? 'up' : 'down') : undefined}
        />
        <Tile
          label="当前连续"
          value={
            o.currentStreakType === 'none'
              ? '—'
              : o.currentStreakType === 'win'
                ? `连胜 ${o.currentStreak}`
                : `连败 ${o.currentStreak}`
          }
          tone={o.currentStreakType === 'win' ? 'up' : o.currentStreakType === 'loss' ? 'down' : undefined}
        />
        <Tile label="最长连胜" value={String(o.maxWinStreak)} tone="up" />
        <Tile label="最长连败" value={String(o.maxLossStreak)} tone="down" />
        <Tile label="近20局胜率" value={pct(o.recent20)} />
        <Tile label="近50 / 100" value={`${pct(o.recent50)} / ${pct(o.recent100)}`} />
      </div>

      <div className="panel card-block" style={{ marginBottom: 16 }}>
        <h2>读数</h2>
        <div className="reading">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {report.reading.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="panel card-block" style={{ marginBottom: 16 }}>
        <h2>权益曲线（正确 +1 / 错误 −1，跳过不计入）与滚动胜率</h2>
        {report.equity.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            尚无已作答对局，跳过不计入权益曲线。
          </p>
        ) : (
          <EquityChart equity={report.equity} />
        )}
      </div>

      <div className="slice-grid">
        <SliceTable title="按模式" rows={report.byMode} />
        <SliceTable title="按品种" rows={report.bySymbol} />
        <SliceTable title="按预测周期" rows={report.byPlayTf} />
        <SliceTable title="按答题时图表周期" rows={report.byChartTf} />
        <SliceTable title="按交易时段" rows={report.bySession} />
        <SliceTable title="按星期" rows={report.byDow} />
        <SliceTable title="按小时（Chicago）" rows={report.byHour} />
        <SliceTable title="按预测方向" rows={report.byPredicted} />
        <SliceTable title="按实际方向" rows={report.byActual} />
        <SliceTable title="按波动分位（先验 ATR%）" rows={report.byVol} />
        <SliceTable title="按实体大小（事后分析）" rows={report.byRange} note="事后分析：揭晓后才可知，不可用于当手下注。" />
      </div>

      <div className="panel card-block">
        <div className="filter-row">
          <h2 style={{ margin: 0 }}>最近对局</h2>
          <select value={filterSym} onChange={(e) => setFilterSym(e.target.value as SymbolId | 'all')}>
            <option value="all">全部品种</option>
            <option value="ES">ES</option>
            <option value="NQ">NQ</option>
          </select>
          <select value={filterMode} onChange={(e) => setFilterMode(e.target.value as PlayMode | 'all')}>
            <option value="all">全部模式</option>
            <option value="direction">下一根方向</option>
            <option value="bracket">止盈止损</option>
          </select>
          <select value={filterTf} onChange={(e) => setFilterTf(e.target.value as Timeframe | 'all')}>
            <option value="all">全部预测周期</option>
            {Object.entries(TIMEFRAME_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>时间</th>
                <th>品种</th>
                <th>预测周期</th>
                <th>图表周期</th>
                <th>模式</th>
                <th>预测</th>
                <th>实际</th>
                <th>结果</th>
                <th>截止(CT)</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 100).map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.playedAt).toLocaleString('zh-CN')}</td>
                  <td>{r.symbol}</td>
                  <td>{TIMEFRAME_LABELS[r.playTf]}</td>
                  <td>{TIMEFRAME_LABELS[r.chartTf]}</td>
                  <td>{(r.mode ?? 'direction') === 'bracket' ? '止盈止损' : '方向'}</td>
                  <td className={r.predicted === 'up' ? 'up' : r.predicted === 'down' ? 'down' : 'muted'}>
                    {predictText(r)}
                  </td>
                  <td className={actualClass(r)}>{actualText(r)}</td>
                  <td className={isSkipped(r) ? 'skip' : r.correct == null ? 'skip' : r.correct ? 'up' : 'down'}>
                    {isSkipped(r) ? '跳过' : r.correct == null ? '未触及' : r.correct ? '正确' : '错误'}
                  </td>
                  <td>{formatChicago(r.cutoff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function predictText(r: RoundRecord): string {
  if (r.predicted == null) return '—';
  if ((r.mode ?? 'direction') === 'bracket') return r.predicted === 'up' ? '做多' : '做空';
  return r.predicted === 'up' ? '涨' : '跌';
}

function actualText(r: RoundRecord): string {
  if ((r.mode ?? 'direction') === 'bracket') {
    if (r.outcome === 'tp') return '止盈';
    if (r.outcome === 'sl') return '止损';
    if (isSkipped(r)) return '—';
    return '未触及';
  }
  if (r.actual === 'up') return '涨';
  if (r.actual === 'down') return '跌';
  return '—';
}

function actualClass(r: RoundRecord): string {
  if ((r.mode ?? 'direction') === 'bracket') {
    if (r.outcome === 'tp') return 'up';
    if (r.outcome === 'sl') return 'down';
    return 'muted';
  }
  if (r.actual === 'up') return 'up';
  if (r.actual === 'down') return 'down';
  return 'muted';
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down' | 'warn';
}) {
  return (
    <div className="panel stat-tile">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

function pct(v: number | null): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function SliceTable({ title, rows, note }: { title: string; rows: SliceStat[]; note?: string }) {
  return (
    <div className="panel card-block">
      <h2>{title}</h2>
      {note ? <p className="muted" style={{ fontSize: 11, marginTop: -6 }}>{note}</p> : null}
      <div className="table-wrap" style={{ maxHeight: 240 }}>
        <table className="data">
          <thead>
            <tr>
              <th>分片</th>
              <th>作答</th>
              <th>跳过</th>
              <th>胜率</th>
              <th>区间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  {r.label}{' '}
                  {r.insufficient ? <span className="insufficient">样本不足</span> : null}
                </td>
                <td>{r.n}</td>
                <td className={r.skips ? 'skip' : 'muted'}>{r.skips}</td>
                <td className={r.n === 0 ? 'muted' : r.winRate >= 0.5 ? 'up' : 'down'}>
                  {r.n ? `${(r.winRate * 100).toFixed(1)}%` : '—'}
                </td>
                <td className="muted">
                  {r.n
                    ? `${((r.wilsonLow ?? 0) * 100).toFixed(0)}–${((r.wilsonHigh ?? 0) * 100).toFixed(0)}%`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EquityChart({ equity }: { equity: { i: number; equity: number; rolling: number }[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || equity.length === 0) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w <= 0 || h <= 0) return;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      paintEquity(ctx, equity, w, h);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [equity]);

  return <canvas ref={ref} className="equity-canvas" />;
}

function paintEquity(
  ctx: CanvasRenderingContext2D,
  equity: { i: number; equity: number; rolling: number }[],
  w: number,
  h: number,
) {

    const pad = { l: 36, r: 12, t: 16, b: 24 };
    const eqs = equity.map((e) => e.equity);
    const minE = Math.min(...eqs, 0);
    const maxE = Math.max(...eqs, 0);
    const span = Math.max(1, maxE - minE);

    const xOf = (i: number) => pad.l + ((w - pad.l - pad.r) * i) / Math.max(1, equity.length - 1);
    const yEq = (v: number) => pad.t + ((maxE - v) / span) * (h - pad.t - pad.b);
    const yRoll = (v: number) => pad.t + (1 - v) * (h - pad.t - pad.b);

    // zero line
    ctx.strokeStyle = '#2a3544';
    ctx.beginPath();
    ctx.moveTo(pad.l, yEq(0));
    ctx.lineTo(w - pad.r, yEq(0));
    ctx.stroke();

    // equity
    ctx.strokeStyle = '#3d9cfd';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    equity.forEach((e, i) => {
      const x = xOf(i);
      const y = yEq(e.equity);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // rolling wr
    ctx.strokeStyle = '#26a69a';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    equity.forEach((e, i) => {
      const x = xOf(i);
      const y = yRoll(e.rolling);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '11px IBM Plex Mono, monospace';
    const equityLabel = `权益 ${eqs[eqs.length - 1]}`;
    const rollLabel = '滚动胜率';
    ctx.fillStyle = '#5c6b7d';
    ctx.fillText(equityLabel, pad.l, 12);
    const rollX = pad.l + ctx.measureText(equityLabel).width + 16;
    if (rollX + ctx.measureText(rollLabel).width <= w - 8) {
      ctx.fillStyle = '#26a69a';
      ctx.fillText(rollLabel, rollX, 12);
    }
}
