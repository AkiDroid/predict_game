import { describe, expect, it } from 'vitest';
import { barEndUnix, bucketStartUnix, TF_SECONDS } from './resample';
import {
  chicagoLocalToUtcMs,
  chicagoSecondOfDay,
  formatChicago,
  getChicagoParts,
  sessionEndUnix,
  sessionOpenUnix,
  tradeDateKey,
  tradeDateWeekday,
  tradeSessionEndUnix,
  weekdayIndex,
} from './time';

type Parts = ReturnType<typeof getChicagoParts>;

/** The previous Intl.formatToParts implementation, kept as the reference. */
const legacy = (() => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  function partsOf(ms: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of formatter.formatToParts(new Date(ms))) {
      if (p.type !== 'literal') out[p.type] = p.value;
    }
    return out;
  }
  function localToUtcMs(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
    let guess = Date.UTC(year, month - 1, day, hour + 6, minute, second);
    for (let i = 0; i < 4; i++) {
      const p = partsOf(guess);
      const asUtc = Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
        Number(p.second ?? '0'),
      );
      guess += Date.UTC(year, month - 1, day, hour, minute, second) - asUtc;
    }
    return guess;
  }
  function parts(unixSec: number): Parts {
    const p = partsOf(unixSec * 1000);
    return {
      year: Number(p.year),
      month: Number(p.month),
      day: Number(p.day),
      hour: Number(p.hour),
      minute: Number(p.minute),
      second: Number(p.second ?? '0'),
      weekday: p.weekday,
    };
  }
  function tradeDateKey(p: Parts): string {
    let y = p.year;
    let m = p.month;
    let d = p.day;
    if (p.hour >= 17) {
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      y = next.getUTCFullYear();
      m = next.getUTCMonth() + 1;
      d = next.getUTCDate();
    }
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function sessionEndUnix(tradeDate: string): number {
    const [y, m, d] = tradeDate.split('-').map(Number);
    return Math.floor(localToUtcMs(y, m, d, 17, 0) / 1000);
  }
  function sessionOpenUnix(tradeDate: string): number {
    const [y, m, d] = tradeDate.split('-').map(Number);
    return Math.floor((localToUtcMs(y, m, d, 17, 0) - 24 * 3600 * 1000) / 1000);
  }
  const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  function bucketStartUnix(unixSec: number, p: Parts, tf: keyof typeof TF_SECONDS): number {
    const sec = TF_SECONDS[tf];
    const dayOpen = unixSec - p.hour * 3600 - p.minute * 60 - p.second;
    const sod = p.hour * 3600 + p.minute * 60 + p.second;
    const anchor = tf === '4h' ? 17 * 3600 : 0;
    const sinceAnchor = (((sod - anchor) % 86400) + 86400) % 86400;
    return dayOpen + sod - (sinceAnchor % sec);
  }
  return {
    localToUtcMs,
    parts,
    tradeDateKey,
    sessionEndUnix,
    sessionOpenUnix,
    bucketStartUnix,
    weekdayIndex: (p: Parts) => WEEKDAY[p.weekday] ?? 0,
    tradeDateWeekday: (key: string) => {
      const [y, m, d] = key.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    },
  };
})();

const INTRADAY = Object.keys(TF_SECONDS) as (keyof typeof TF_SECONDS)[];
const sessionEnds = new Map<string, number>();
const pad = (n: number) => String(n).padStart(2, '0');

/** Every fast helper against the Intl reference at one instant; returns the first mismatch. */
function mismatchAt(t: number): string | null {
  const p = legacy.parts(t);
  const fast = getChicagoParts(t);
  const differs = (name: string, got: unknown, want: unknown) => (got === want ? null : `${name}(${t}): ${got} != ${want}`);
  for (const k of Object.keys(p) as (keyof Parts)[]) {
    const bad = differs(`parts.${k}`, fast[k], p[k]);
    if (bad) return bad;
  }
  const key = legacy.tradeDateKey(p);
  let end = sessionEnds.get(key);
  if (end == null) {
    end = legacy.sessionEndUnix(key);
    sessionEnds.set(key, end);
  }
  const checks: [string, unknown, unknown][] = [
    ['sod', chicagoSecondOfDay(t), p.hour * 3600 + p.minute * 60 + p.second],
    ['weekdayIndex', weekdayIndex(t), legacy.weekdayIndex(p)],
    ['tradeDateKey', tradeDateKey(t), key],
    ['tradeDateWeekday', tradeDateWeekday(t), legacy.tradeDateWeekday(key)],
    ['tradeSessionEndUnix', tradeSessionEndUnix(t), end],
    ['barEndUnix 1d', barEndUnix(t, '1d'), end],
    ['formatChicago', formatChicago(t), `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`],
    ...INTRADAY.map((tf): [string, unknown, unknown] => [`bucket ${tf}`, bucketStartUnix(t, tf), legacy.bucketStartUnix(t, p, tf)]),
  ];
  for (const [name, got, want] of checks) {
    const bad = differs(name, got, want);
    if (bad) return bad;
  }
  return null;
}

function expectSameAt(instants: Iterable<number>): number {
  let n = 0;
  for (const t of instants) {
    const bad = mismatchAt(t);
    if (bad) expect.fail(bad);
    n++;
  }
  return n;
}

function* range(from: number, to: number, step: number): Generator<number> {
  for (let t = from; t < to; t += step) yield t;
}

/** UTC instants just after each US DST switch in Chicago for the given year. */
function dstSwitches(year: number): number[] {
  const out: number[] = [];
  const from = Date.UTC(year, 0, 1) / 1000;
  let prev = legacy.parts(from).hour;
  for (let t = from + 3600; t < Date.UTC(year + 1, 0, 1) / 1000; t += 3600) {
    const hour = legacy.parts(t).hour;
    if ((hour - prev + 24) % 24 !== 1) out.push(t);
    prev = hour;
  }
  return out;
}

const SWITCHES = new Map<number, number[]>();
for (let year = 1985; year <= 2030; year++) SWITCHES.set(year, dstSwitches(year));

describe('Chicago civil time fast paths', () => {
  it('match Intl across 1985–2035 and outside the arithmetic range', () => {
    // 7 minutes 13 seconds × 37 keeps the stride off whole hours and days.
    const n = expectSameAt(range(Date.UTC(1985, 0, 1) / 1000, Date.UTC(2036, 0, 1) / 1000, 37 * (7 * 60 + 13)));
    expect(n).toBeGreaterThan(90_000);
    expectSameAt([0, -1, -86_399.5, 60.5, 1_700_000_000.25, 1_700_000_000.999, Date.UTC(2250, 5, 1) / 1000]);
  });

  it('match Intl on a 7-minute grid over 2009–2026, sampling every 13th point', () => {
    expectSameAt(range(Date.UTC(2009, 0, 1) / 1000 + 7 * 60, Date.UTC(2027, 0, 1) / 1000, 13 * 7 * 60));
  });

  it('match Intl minute by minute around every DST switch', { timeout: 30_000 }, () => {
    for (let year = 1987; year <= 2030; year++) {
      const switches = SWITCHES.get(year)!;
      expect(switches, `${year}`).toHaveLength(2);
      for (const at of switches) {
        expectSameAt(range(at - 3 * 3600, at + 3 * 3600, 60));
        expectSameAt(range(at - 3 * 3600 - 1, at + 3 * 3600, 3600));
        // The 17:00 CT session boundaries on either side of the switch day.
        expectSameAt(range(at - 2 * 86400, at + 2 * 86400, 900));
      }
    }
  });

  it('convert wall times like the Intl iteration, including gaps and repeated hours', { timeout: 30_000 }, () => {
    const cases: number[][] = [];
    for (let year = 1985; year <= 2030; year++) {
      for (const at of SWITCHES.get(year)!) {
        const p = legacy.parts(at - 86400);
        for (let dd = 0; dd <= 2; dd++) {
          for (let h = 0; h < 24; h++) {
            for (const mi of [0, 30, 59]) cases.push([p.year, p.month, p.day + dd, h, mi]);
          }
        }
      }
      cases.push([year, 1, 1, 0, 0], [year, 12, 31, 23, 59, 59], [year, 6, 15, 17, 0]);
    }
    cases.push([2024, 2, 30, 17, 0], [2023, 1, 401, 17, 0], [2024, 3, 10, 2, 30, 15]);
    for (const [y, m, d, h, mi, s] of cases) {
      const got = chicagoLocalToUtcMs(y!, m!, d!, h!, mi!, s);
      const want = legacy.localToUtcMs(y!, m!, d!, h!, mi!, s);
      if (got !== want) expect.fail(`${y}-${m}-${d} ${h}:${mi}:${s ?? 0}: ${got} != ${want}`);
    }
  });

  it('match Intl for session open/end of every trade date 1987–2035', { timeout: 30_000 }, () => {
    for (let t = Date.UTC(1987, 0, 1) / 1000; t < Date.UTC(2036, 0, 1) / 1000; t += 86400) {
      const key = legacy.tradeDateKey(legacy.parts(t));
      const end = sessionEnds.get(key) ?? legacy.sessionEndUnix(key);
      if (sessionEndUnix(key) !== end) expect.fail(`sessionEndUnix(${key})`);
      if (sessionOpenUnix(key) !== end - 86400) expect.fail(`sessionOpenUnix(${key})`);
    }
    expect(legacy.sessionOpenUnix('2024-03-11')).toBe(sessionOpenUnix('2024-03-11'));
  });
});
