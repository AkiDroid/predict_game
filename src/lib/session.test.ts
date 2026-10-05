import { describe, expect, it } from 'vitest';
import { sessionBucket } from './session';
import { chicagoLocalToUtcMs, chicagoOffsetSeconds } from './time';
import { zoneOffsetMinutes } from './timezone';

function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return Math.floor(chicagoLocalToUtcMs(year, month, day, hour, minute) / 1000);
}

describe('chicago civil time', () => {
  it('keeps the session boundaries', () => {
    expect(sessionBucket(at(2024, 6, 3, 15, 59))).toBe('america_rth');
    expect(sessionBucket(at(2024, 6, 3, 16, 59))).toBe('america_eth');
    expect(sessionBucket(at(2024, 6, 3, 17, 0))).toBe('asia');
    expect(sessionBucket(at(2024, 6, 3, 2, 59))).toBe('asia');
    expect(sessionBucket(at(2024, 6, 3, 3, 0))).toBe('europe');
    expect(sessionBucket(at(2024, 6, 3, 8, 29))).toBe('europe');
    expect(sessionBucket(at(2024, 6, 3, 8, 30))).toBe('america_rth');
    expect(sessionBucket(at(2024, 6, 3, 16, 0))).toBe('america_eth');
    expect(sessionBucket(at(2024, 3, 10, 1, 30))).toBe('asia');
    expect(sessionBucket(at(2024, 3, 10, 3, 30))).toBe('europe');
  });

  it('matches Intl offsets across DST, including the pre-2007 rules', () => {
    const check = (t: number) => {
      const got = chicagoOffsetSeconds(t);
      const expected = zoneOffsetMinutes('America/Chicago', t) * 60;
      if (got !== expected) {
        throw new Error(`${new Date(t * 1000).toISOString()} offset ${got} !== ${expected}`);
      }
    };

    check(Math.floor(Date.UTC(1980, 6, 1, 12) / 1000));
    for (let year = 2000; year <= 2026; year++) {
      for (let month = 0; month < 12; month++) {
        check(Math.floor(Date.UTC(year, month, 15, 12) / 1000));
      }
      for (const month of [2, 3, 9, 10]) {
        for (let day = 1; day <= 14; day++) {
          for (let hour = 0; hour < 24; hour += 1) {
            check(Math.floor(Date.UTC(year, month, day, hour, 30) / 1000));
          }
        }
      }
    }
  });
});
