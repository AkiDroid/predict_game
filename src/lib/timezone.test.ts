import { describe, expect, it } from 'vitest';
import { formatOffset, formatZoned, zoneOffsetMinutes } from './timezone';

const T = Date.UTC(2026, 8, 30, 12, 44) / 1000;

describe('timezone formatting', () => {
  it('formats as YYYY/MM/dd  HH:mm in the chosen zone', () => {
    expect(formatZoned(T, 'Asia/Shanghai')).toBe('2026/09/30  20:44');
    expect(formatZoned(T, 'UTC')).toBe('2026/09/30  12:44');
    expect(formatZoned(T, 'America/Chicago')).toBe('2026/09/30  07:44');
  });

  it('pads and uses 24-hour time across midnight', () => {
    const t = Date.UTC(2026, 0, 4, 16, 5) / 1000;
    expect(formatZoned(t, 'Asia/Shanghai')).toBe('2026/01/05  00:05');
  });

  it('labels offsets with DST at the given instant', () => {
    expect(formatOffset(zoneOffsetMinutes('Asia/Shanghai', T))).toBe('UTC+8');
    expect(formatOffset(zoneOffsetMinutes('America/Chicago', T))).toBe('UTC-5');
    expect(formatOffset(zoneOffsetMinutes('America/Chicago', Date.UTC(2026, 0, 5) / 1000))).toBe('UTC-6');
    expect(formatOffset(zoneOffsetMinutes('Asia/Kolkata', T))).toBe('UTC+5:30');
    expect(formatOffset(zoneOffsetMinutes('UTC', T))).toBe('UTC');
  });
});
