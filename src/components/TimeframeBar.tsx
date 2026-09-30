import { TIMEFRAMES, TIMEFRAME_LABELS, type Timeframe } from '../lib/types';

export function TimeframeBar({
  value,
  onChange,
}: {
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
}) {
  return (
    <div className="tf-bar" role="toolbar" aria-label="图表周期">
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          type="button"
          className={tf === value ? 'active' : ''}
          onClick={() => onChange(tf)}
        >
          {TIMEFRAME_LABELS[tf]}
        </button>
      ))}
    </div>
  );
}
