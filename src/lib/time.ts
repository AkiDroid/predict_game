/** America/Chicago helpers for CME equity-index futures timestamps. */

const TZ = 'America/Chicago';

const chicagoFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
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
  for (const p of chicagoFormatter.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

/** Convert Chicago wall-clock local time → UTC epoch ms. */
export function chicagoLocalToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): number {
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
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    guess += desired - asUtc;
  }
  return guess;
}

export function parseDataTimestamp(dateStr: string, timeStr: string): number {
  const [mm, dd, yyyy] = dateStr.split('/').map(Number);
  const [hh, mi] = timeStr.split(':').map(Number);
  return Math.floor(chicagoLocalToUtcMs(yyyy, mm, dd, hh, mi) / 1000);
}

export function parseDailyDate(dateStr: string): number {
  const [mm, dd, yyyy] = dateStr.split('/').map(Number);
  // Daily file date ≈ trade/session date; use session open = prior calendar day 17:00 CT
  const openMs = chicagoLocalToUtcMs(yyyy, mm, dd, 17, 0) - 24 * 3600 * 1000;
  return Math.floor(openMs / 1000);
}

export interface ChicagoParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

const STD_OFFSET_SEC = -6 * 3600;
const DST_OFFSET_SEC = -5 * 3600;

let offsetYearStart = Number.NEGATIVE_INFINITY;
let offsetYearEnd = Number.NEGATIVE_INFINITY;
let offsetDstStart = 0;
let offsetDstEnd = 0;
let offsetLegacy = false;

/**
 * Seconds to add to a Unix timestamp to get America/Chicago civil time.
 * DST follows the US rules: 1987–2006 first Sunday in April through last Sunday
 * in October, and from 2007 the second Sunday in March through the first Sunday
 * in November. The clock changes at 02:00 local. Earlier years stay on Intl.
 */
export function chicagoOffsetSeconds(unixSec: number): number {
  if (unixSec < offsetYearStart || unixSec >= offsetYearEnd) {
    const year = new Date(unixSec * 1000).getUTCFullYear();
    offsetYearStart = Date.UTC(year, 0, 1) / 1000;
    offsetYearEnd = Date.UTC(year + 1, 0, 1) / 1000;
    offsetLegacy = year < 1987;
    if (!offsetLegacy) {
      const bounds = chicagoDstBounds(year);
      offsetDstStart = bounds.start;
      offsetDstEnd = bounds.end;
    }
  }
  if (offsetLegacy) return chicagoOffsetFromParts(unixSec);
  return unixSec >= offsetDstStart && unixSec < offsetDstEnd ? DST_OFFSET_SEC : STD_OFFSET_SEC;
}

function chicagoOffsetFromParts(unixSec: number): number {
  const whole = Math.floor(unixSec);
  const p = partsOf(whole * 1000);
  const wall =
    Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour === '24' ? '0' : p.hour),
      Number(p.minute),
      Number(p.second ?? '0'),
    ) / 1000;
  return Math.round(wall - whole);
}

function chicagoDstBounds(year: number): { start: number; end: number } {
  if (year >= 2007) {
    return {
      start: Date.UTC(year, 2, nthSunday(year, 2, 2), 8, 0, 0) / 1000,
      end: Date.UTC(year, 10, nthSunday(year, 10, 1), 7, 0, 0) / 1000,
    };
  }
  return {
    start: Date.UTC(year, 3, nthSunday(year, 3, 1), 8, 0, 0) / 1000,
    end: Date.UTC(year, 9, lastSunday(year, 9), 7, 0, 0) / 1000,
  };
}

function nthSunday(year: number, monthIndex: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

function lastSunday(year: number, monthIndex: number): number {
  const lastDate = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, monthIndex, lastDate)).getUTCDay();
  return lastDate - lastDow;
}

export function getChicagoParts(unixSec: number): ChicagoParts {
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

export function formatChicago(unixSec: number): string {
  const p = getChicagoParts(unixSec);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * CME Globex-style trade date for equity index futures.
 * Session opens ~17:00 CT and closes next calendar day ~16:59 CT.
 * Bars with local hour >= 17 belong to the next trade date.
 */
export function tradeDateKey(unixSec: number): string {
  const p = getChicagoParts(unixSec);
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

/** Session open unix (17:00 CT of prior calendar day relative to trade date). */
export function sessionOpenUnix(tradeDate: string): number {
  const [y, m, d] = tradeDate.split('-').map(Number);
  const openMs = chicagoLocalToUtcMs(y, m, d, 17, 0) - 24 * 3600 * 1000;
  return Math.floor(openMs / 1000);
}

/** Session end unix (exclusive): 17:00 CT on trade date. */
export function sessionEndUnix(tradeDate: string): number {
  const [y, m, d] = tradeDate.split('-').map(Number);
  return Math.floor(chicagoLocalToUtcMs(y, m, d, 17, 0) / 1000);
}

export const TIMEZONE_LABEL = 'America/Chicago (CME)';

export function weekdayIndex(unixSec: number): number {
  // 0=Sun ... 6=Sat in Chicago
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[getChicagoParts(unixSec).weekday] ?? 0;
}
