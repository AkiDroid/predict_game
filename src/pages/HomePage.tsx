import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DatePicker } from '../components/DatePicker';
import { fetchHealth } from '../lib/api';
import { SESSION_LABELS } from '../lib/session';
import { ALL_SESSIONS, loadSettings, saveSettings, type GameSettings } from '../lib/settings';
import {
  PLAY_MODE_LABELS,
  SYMBOL_META,
  TIMEFRAMES,
  TIMEFRAME_LABELS,
  type PlayMode,
  type SessionBucket,
  type SymbolId,
  type Timeframe,
} from '../lib/types';

export function HomePage() {
  const nav = useNavigate();
  const [settings, setSettings] = useState<GameSettings>(() => loadSettings());
  const [sessions, setSessions] = useState<SessionBucket[]>([]);
  const [health, setHealth] = useState<{ ok: boolean; error?: string; info?: string }>({
    ok: false,
  });

  useEffect(() => {
    fetchHealth()
      .then((h) => {
        if (!h.ok) setHealth({ ok: false, error: h.error });
        else {
          const es = h.loaded.find((x) => x.symbol === 'ES' && x.tf === '1m');
          setHealth({
            ok: true,
            info: es
              ? `已加载 ${h.loaded.length} 组序列 · ES 1m ${es.count.toLocaleString()} 根`
              : `已加载 ${h.loaded.length} 组序列`,
          });
        }
      })
      .catch((e) => setHealth({ ok: false, error: String(e) }));
  }, []);

  function update(partial: Partial<GameSettings>) {
    setSettings((s) => {
      const next = { ...s, ...partial };
      saveSettings(next);
      return next;
    });
  }

  function start() {
    const filters = {
      ...settings.filters,
      sessions: sessions.length ? sessions : undefined,
    };
    const next = { ...settings, filters };
    saveSettings(next);
    nav('/play', { state: { autoStart: true } });
  }

  return (
    <div className="page">
      <h1>K线预测</h1>
      <p className="lead">
        基于历史期货行情，在截止时刻之后做判断。可以猜下一根K线的涨跌，也可以在图上拖出止盈和止损，看价格先碰到哪一边。图表在对局中严格屏蔽未来信息。
      </p>

      {!health.ok && health.error ? <div className="error-banner">{health.error}</div> : null}
      {health.ok && health.info ? (
        <p className="muted" style={{ marginTop: -8, marginBottom: 16, fontSize: 12 }}>
          {health.info}
        </p>
      ) : null}

      <div className="grid-setup">
        <section className="panel card-block">
          <h2>对局设置</h2>
          <div style={{ display: 'grid', gap: 14 }}>
            <div className="field">
              <label>模式</label>
              <div className="choice-row">
                {(Object.keys(PLAY_MODE_LABELS) as PlayMode[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`btn ${settings.mode === id ? 'btn-primary' : ''}`}
                    onClick={() => update({ mode: id })}
                  >
                    {PLAY_MODE_LABELS[id]}
                  </button>
                ))}
              </div>
              <span className="muted" style={{ fontSize: 11 }}>
                {settings.mode === 'bracket'
                  ? '在图上拖动止盈、止损。盈亏比固定 1:1，距离不小于 1×ATR(14)。先碰到止盈算赢，先碰到止损算输。'
                  : '判断下一根K线收盘相对开盘是涨还是跌。'}
              </span>
            </div>
            <div className="field">
              <label>品种</label>
              <select
                value={settings.symbol}
                onChange={(e) => update({ symbol: e.target.value as SymbolId })}
              >
                {(Object.keys(SYMBOL_META) as SymbolId[]).map((id) => (
                  <option key={id} value={id}>
                    {SYMBOL_META[id].fullName} / {id}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>预测周期{settings.mode === 'bracket' ? '（止盈止损按这个周期的 ATR，并沿这个周期往后看）' : '（判定涨跌的K线周期）'}</label>
              <select
                value={settings.playTf}
                onChange={(e) => update({ playTf: e.target.value as Timeframe })}
              >
                {TIMEFRAMES.map((tf) => (
                  <option key={tf} value={tf}>
                    {TIMEFRAME_LABELS[tf]}
                  </option>
                ))}
              </select>
            </div>
            <div className="date-fields">
              <div className="field">
                <label>起始日期（可选）</label>
                <DatePicker
                  ariaLabel="起始日期"
                  edge="start"
                  value={settings.filters.dateFrom}
                  onChange={(dateFrom) =>
                    update({ filters: { ...settings.filters, dateFrom } })
                  }
                />
              </div>
              <div className="field">
                <label>结束日期（可选）</label>
                <DatePicker
                  ariaLabel="结束日期"
                  edge="end"
                  value={settings.filters.dateTo}
                  onChange={(dateTo) => update({ filters: { ...settings.filters, dateTo } })}
                />
              </div>
            </div>
            <div className="field">
              <label>交易时段过滤（可选，影响随机题池与统计）</label>
              <div className="choice-row">
                {ALL_SESSIONS.map((s) => {
                  const on = sessions.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      className={`btn btn-sm ${on ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() =>
                        setSessions((prev) =>
                          on ? prev.filter((x) => x !== s) : [...prev, s],
                        )
                      }
                    >
                      {SESSION_LABELS[s]}
                    </button>
                  );
                })}
              </div>
              <span className="muted" style={{ fontSize: 11 }}>
                默认不限制（使用全部可用数据）。时段按时区 America/Chicago 划分。
              </span>
            </div>
            <div className="action-row">
              <button type="button" className="btn btn-primary" onClick={start} disabled={!health.ok}>
                开始游戏
              </button>
              <button type="button" className="btn" onClick={() => nav('/browse')}>
                浏览行情
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => nav('/stats')}>
                统计分析
              </button>
            </div>
          </div>
        </section>

        <section className="panel card-block rules">
          <h2>规则说明</h2>
          <p>
            <strong>方向模式：</strong>涨 = 下一根K线收盘价 &gt; 开盘价；跌 = 收盘价 &lt; 开盘价。
            精确十字星（收盘=开盘）已从随机题池中排除，每局必有明确方向。
          </p>
          <p>
            <strong>止盈止损模式：</strong>入场价是截止时最后一根已收盘K线的收盘价。在图上拖动止盈或止损线，另一条始终保持相同距离，且不能小于
            ATR(14)（按最小跳动向上取整）。之后行情先碰到止盈算赢，先碰到止损算输。先后按 1
            分钟路径判断：跳空看开盘，同一根里两边都碰到时，阳线视为先下后上、阴线视为先上后下。500
            根预测周期K线内都没碰到，记为未触及，不计胜负。
          </p>
          <p>
            <strong>颜色约定：</strong>本产品标的为美股指数期货，采用<strong>绿涨 / 红跌</strong>
            （与国内股市红涨绿跌相反）。
          </p>
          <p>
            <strong>防未来函数：</strong>对局中图表在任意周期均截止于预测目标K线开盘时刻 T。
            更小周期不会露出目标K线内部的细线；更大周期不会显示仍包含未来的未收盘K线。
          </p>
          <ul>
            <li>方向模式快捷键：↑ 涨 · ↓ 跌 · X 跳过 · Enter/Space 下一题</li>
            <li>
              止盈止损：在图上拖动止盈或止损调整距离（触控屏拖右侧圆点，也可用 +/−）。键盘 ↑ 做多 · ↓ 做空 · Enter
              确认 · X 跳过
            </li>
            <li>行情、出题与个人对局统计均由后端提供；统计绑定当前账号，登录后可跨设备同步</li>
            <li>图表周期可随时切换，与预测周期相互独立</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
