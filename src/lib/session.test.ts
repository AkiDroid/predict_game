import { describe, expect, it } from 'vitest';
import { decisionMeta, sessionBucket } from './session';
import {
  chicagoLocalToUtcMs,
  chicagoOffsetSeconds,
  easternLocalToUnix,
  parseDataTimestamp,
  tradeDateKey,
} from './time';
import { zoneOffsetMinutes } from './timezone';

function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return Math.floor(chicagoLocalToUtcMs(year, month, day, hour, minute) / 1000);
}

describe('chicago civil time', () => {
  it('keeps the session boundaries', () => {
    expect(sessionBucket(at(2024, 6, 3, 14, 59))).toBe('america_rth');
    expect(sessionBucket(at(2024, 6, 3, 15, 0))).toBe('america_eth');
    expect(sessionBucket(at(2024, 6, 3, 15, 59))).toBe('america_eth');
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

  it('reads raw data rows as US Eastern wall time', () => {
    // Cash open 09:30 ET is 08:30 CT; Globex reopen 18:00 ET is 17:00 CT, in summer and winter.
    expect(parseDataTimestamp('06/03/2024', '09:30')).toBe(at(2024, 6, 3, 8, 30));
    expect(parseDataTimestamp('01/08/2024', '09:30')).toBe(at(2024, 1, 8, 8, 30));
    expect(parseDataTimestamp('01/07/2024', '18:00')).toBe(at(2024, 1, 7, 17, 0));
    expect(parseDataTimestamp('06/03/2024', '15:59')).toBe(at(2024, 6, 3, 14, 59));
    expect(sessionBucket(parseDataTimestamp('06/03/2024', '09:30'))).toBe('america_rth');
    expect(sessionBucket(parseDataTimestamp('06/03/2024', '16:00'))).toBe('america_eth');
    expect(tradeDateKey(parseDataTimestamp('06/02/2024', '18:00'))).toBe('2024-06-03');
  });

  it('matches Intl for Eastern wall time across DST', () => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    for (let year = 1990; year <= 2026; year++) {
      for (const [month, day] of [
        [1, 15],
        [3, 9],
        [3, 12],
        [4, 2],
        [7, 4],
        [10, 30],
        [11, 3],
        [11, 6],
      ]) {
        for (const hour of [0, 1, 3, 9, 16, 18, 23]) {
          const t = easternLocalToUnix(year, month, day, hour, 30);
          const p = Object.fromEntries(fmt.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
          const label = `${year}-${month}-${day} ${hour}:30`;
          expect(`${Number(p.month)}-${Number(p.day)} ${Number(p.hour)}:${p.minute}`, label).toBe(
            `${month}-${day} ${hour}:30`,
          );
        }
      }
    }
  });

  it('labels daily rounds with the trade date weekday', () => {
    // Daily bar for Monday 2024-06-03 opens Sunday 17:00 CT.
    const open = at(2024, 6, 2, 17, 0);
    expect(decisionMeta(open, '1d').dayOfWeek).toBe(1);
    expect(decisionMeta(open, '1h')).toEqual({ session: 'asia', hour: 17, dayOfWeek: 0 });
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
