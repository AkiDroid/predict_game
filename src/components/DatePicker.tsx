import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { chicagoLocalToUtcMs, getChicagoParts } from '../lib/time';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Monday-based offset of the 1st (0 = Monday). */
function leadingBlanks(year: number, month: number) {
  const sunday0 = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return (sunday0 + 6) % 7;
}

function shiftMonth(year: number, month: number, delta: number) {
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
}

function CalendarIcon() {
  return (
    <svg className="date-picker-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 6.2h13" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 1.2v2.4M11 1.2v2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function DatePicker({
  value,
  onChange,
  edge,
  placeholder = '选择日期',
  ariaLabel,
}: {
  value?: number;
  onChange: (unixSec: number | undefined) => void;
  /** Start of the Chicago calendar day, or 23:59 that day. */
  edge: 'start' | 'end';
  placeholder?: string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = value != null ? getChicagoParts(value) : null;
  const [view, setView] = useState(() => {
    const base = selected ?? getChicagoParts(Math.floor(Date.now() / 1000));
    return { year: base.year, month: base.month };
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  function chicagoToday() {
    return getChicagoParts(Math.floor(Date.now() / 1000));
  }

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const base = selected ?? chicagoToday();
    setView({ year: base.year, month: base.month });
    setOpen(true);
  }

  function toUnix(year: number, month: number, day: number) {
    const hour = edge === 'end' ? 23 : 0;
    const minute = edge === 'end' ? 59 : 0;
    return Math.floor(chicagoLocalToUtcMs(year, month, day, hour, minute) / 1000);
  }

  function pick(day: number) {
    onChange(toUnix(view.year, view.month, day));
    setOpen(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
      const swallow = (ev: MouseEvent) => {
        const node = ev.target as Element | null;
        if (node?.closest?.('.date-picker, .date-picker-pop')) return;
        ev.preventDefault();
        ev.stopPropagation();
      };
      document.addEventListener('click', swallow, true);
      window.setTimeout(() => document.removeEventListener('click', swallow, true), 0);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const trigger = triggerRef.current;
    if (!pop || !trigger) return;

    function place() {
      if (!pop || !trigger) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const width = pop.offsetWidth;
      const height = pop.offsetHeight;
      let top = rect.bottom + gap;
      if (top + height > window.innerHeight - margin) {
        const above = rect.top - height - gap;
        if (above >= margin) top = above;
      }
      let left = rect.left;
      if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
      if (left < margin) left = margin;
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
      pop.style.visibility = 'visible';
    }

    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, view.year, view.month]);

  const blanks = leadingBlanks(view.year, view.month);
  const count = daysInMonth(view.year, view.month);
  const cells: Array<number | null> = [
    ...Array.from({ length: blanks }, () => null),
    ...Array.from({ length: count }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const today = chicagoToday();
  const display = selected ? `${selected.year}-${pad(selected.month)}-${pad(selected.day)}` : '';

  return (
    <div className="date-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="date-picker-trigger"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className={display ? 'date-picker-value' : 'date-picker-placeholder'}>
          {display || placeholder}
        </span>
        <CalendarIcon />
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className="date-picker-pop"
              role="dialog"
              aria-label={ariaLabel}
            >
              <div className="date-picker-head">
                <button
                  type="button"
                  className="date-picker-nav"
                  aria-label="上一年"
                  onClick={() => setView((v) => shiftMonth(v.year, v.month, -12))}
                >
                  «
                </button>
                <button
                  type="button"
                  className="date-picker-nav"
                  aria-label="上个月"
                  onClick={() => setView((v) => shiftMonth(v.year, v.month, -1))}
                >
                  ‹
                </button>
                <span className="date-picker-title">
                  {view.year}年{view.month}月
                </span>
                <button
                  type="button"
                  className="date-picker-nav"
                  aria-label="下个月"
                  onClick={() => setView((v) => shiftMonth(v.year, v.month, 1))}
                >
                  ›
                </button>
                <button
                  type="button"
                  className="date-picker-nav"
                  aria-label="下一年"
                  onClick={() => setView((v) => shiftMonth(v.year, v.month, 12))}
                >
                  »
                </button>
              </div>
              <div className="date-picker-weekdays">
                {WEEKDAYS.map((w) => (
                  <span key={w}>{w}</span>
                ))}
              </div>
              <div className="date-picker-grid">
                {cells.map((day, i) => {
                  if (day == null) return <span key={`empty-${i}`} />;
                  const isSelected =
                    selected != null &&
                    selected.year === view.year &&
                    selected.month === view.month &&
                    selected.day === day;
                  const isToday =
                    today.year === view.year && today.month === view.month && today.day === day;
                  return (
                    <button
                      key={day}
                      type="button"
                      className={`date-picker-day${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}`}
                      aria-pressed={isSelected}
                      onClick={() => pick(day)}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
              <div className="date-picker-foot">
                <button
                  type="button"
                  className="date-picker-link"
                  onClick={() => {
                    onChange(undefined);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  清除
                </button>
                <button
                  type="button"
                  className="date-picker-link"
                  onClick={() => {
                    onChange(toUnix(today.year, today.month, today.day));
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  今天
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
