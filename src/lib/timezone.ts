import { useCallback, useSyncExternalStore } from 'react';

export const TIMEZONE_STORAGE_KEY = 'predict_game_timezone_v1';
const CHANGE_EVENT = 'predict-game-timezone';

const FALLBACK_ZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && isValidTimeZone(tz)) return tz;
  } catch {
    /* fall through */
  }
  return 'UTC';
}

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zoneParts(unixSec: number, timeZone: string): ZoneParts {
  const out: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(unixSec * 1000))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second ?? 0,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY/MM/dd  HH:mm` in the given zone (two spaces between date and time). */
export function formatZoned(unixSec: number, timeZone: string): string {
  const p = zoneParts(unixSec, timeZone);
  return `${p.year}/${pad(p.month)}/${pad(p.day)}  ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Offset from UTC in minutes at the given instant. */
export function zoneOffsetMinutes(timeZone: string, unixSec = Date.now() / 1000): number {
  const whole = Math.floor(unixSec);
  const p = zoneParts(whole, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return Math.round((wall - whole) / 60);
}

/** `UTC+8`, `UTC-5`, `UTC+5:30`, `UTC`. */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${pad(m)}` : ''}`;
}

let zoneListCache: string[] | null = null;

export function listTimeZones(): string[] {
  if (zoneListCache) return zoneListCache;
  let zones: string[] = [];
  try {
    if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  const set = new Set(zones.length ? zones : FALLBACK_ZONES);
  set.add('UTC');
  set.add(browserTimeZone());
  zoneListCache = [...set].filter(isValidTimeZone).sort((a, b) => a.localeCompare(b));
  return zoneListCache;
}

export interface TimeZoneOption {
  tz: string;
  label: string;
}

const OPTION_LABEL_TTL_MS = 60 * 60 * 1000;
let zoneOptionsCache: { at: number; options: TimeZoneOption[] } | null = null;

/** `UTC+8 · Asia/Shanghai` labels for every zone; offsets are refreshed at most hourly. */
export function listTimeZoneOptions(): TimeZoneOption[] {
  const now = Date.now();
  if (zoneOptionsCache && now - zoneOptionsCache.at < OPTION_LABEL_TTL_MS) return zoneOptionsCache.options;
  const at = now / 1000;
  const options = listTimeZones().map((tz) => ({ tz, label: `${formatOffset(zoneOffsetMinutes(tz, at))} · ${tz}` }));
  zoneOptionsCache = { at: now, options };
  return options;
}

export function loadTimeZone(): string {
  try {
    const raw = localStorage.getItem(TIMEZONE_STORAGE_KEY);
    if (raw && isValidTimeZone(raw)) return raw;
  } catch {
    /* storage unavailable */
  }
  return browserTimeZone();
}

export function saveTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) return;
  try {
    localStorage.setItem(TIMEZONE_STORAGE_KEY, timeZone);
  } catch {
    /* storage unavailable */
  }
  cachedZone = null;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Last `loadTimeZone()` result; trusted only while a subscriber keeps it invalidated on change. */
let cachedZone: string | null = null;
let subscribers = 0;

function snapshot(): string {
  if (cachedZone == null || subscribers === 0) cachedZone = loadTimeZone();
  return cachedZone;
}

function subscribe(cb: () => void): () => void {
  const onChange = () => {
    cachedZone = null;
    cb();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === TIMEZONE_STORAGE_KEY || e.key === null) onChange();
  };
  subscribers++;
  cachedZone = null;
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    subscribers--;
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** Selected display zone, shared across components and tabs. */
export function useTimeZone(): [string, (timeZone: string) => void] {
  const timeZone = useSyncExternalStore(subscribe, snapshot, snapshot);
  const set = useCallback((next: string) => saveTimeZone(next), []);
  return [timeZone, set];
}
