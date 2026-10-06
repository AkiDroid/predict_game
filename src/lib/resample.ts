import type { Bar, Timeframe } from './types';
import { chicagoSecondOfDay, sessionOpenUnix, tradeDateKey, tradeSessionEndUnix } from './time';

export const TF_SECONDS: Record<Exclude<Timeframe, '1d'>, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
};

export function barEndUnix(barOpen: number, tf: Timeframe): number {
  if (tf === '1d') {
    return tradeSessionEndUnix(barOpen);
  }
  return barOpen + TF_SECONDS[tf];
}

/**
 * Bucket start in America/Chicago wall time. Up to 1h buckets align to the clock;
 * 4h buckets align to the 17:00 CT session open (17, 21, 01, 05, 09, 13), so none
 * opens inside the 16:00–17:00 halt.
 */
export function bucketStartUnix(unixSec: number, tf: Exclude<Timeframe, '1d'>): number {
  const sec = TF_SECONDS[tf];
  const sod = chicagoSecondOfDay(unixSec);
  const dayOpen = unixSec - sod;
  const anchor = tf === '4h' ? 17 * 3600 : 0;
  const sinceAnchor = (((sod - anchor) % 86400) + 86400) % 86400;
  return dayOpen + sod - (sinceAnchor % sec);
}

function pushAgg(
  out: Bar[],
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
): void {
  out.push({ t, o, h, l, c, v });
}

/**
 * Resample 1-minute bars to a higher timeframe.
 * Does not invent bars across gaps — a bucket exists only if ≥1 source bar falls in it.
 */
export function resampleOHLCV(bars1m: Bar[], tf: Timeframe): Bar[] {
  if (tf === '1m') return bars1m.slice();
  if (bars1m.length === 0) return [];

  if (tf === '1d') {
    const out: Bar[] = [];
    let key = '';
    let o = 0;
    let h = 0;
    let l = 0;
    let c = 0;
    let v = 0;
    let openT = 0;

    for (const b of bars1m) {
      const k = tradeDateKey(b.t);
      if (k !== key) {
        if (key) pushAgg(out, openT, o, h, l, c, v);
        key = k;
        openT = sessionOpenUnix(k);
        o = b.o;
        h = b.h;
        l = b.l;
        c = b.c;
        v = b.v;
      } else {
        if (b.h > h) h = b.h;
        if (b.l < l) l = b.l;
        c = b.c;
        v += b.v;
      }
    }
    if (key) pushAgg(out, openT, o, h, l, c, v);
    return out;
  }

  const out: Bar[] = [];
  let curBucket = -1;
  let o = 0;
  let h = 0;
  let l = 0;
  let c = 0;
  let v = 0;

  for (const b of bars1m) {
    const bucket = bucketStartUnix(b.t, tf);
    if (bucket !== curBucket) {
      if (curBucket >= 0) pushAgg(out, curBucket, o, h, l, c, v);
      curBucket = bucket;
      o = b.o;
      h = b.h;
      l = b.l;
      c = b.c;
      v = b.v;
    } else {
      if (b.h > h) h = b.h;
      if (b.l < l) l = b.l;
      c = b.c;
      v += b.v;
    }
  }
  if (curBucket >= 0) pushAgg(out, curBucket, o, h, l, c, v);
  return out;
}
