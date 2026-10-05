import type { SessionBucket, Timeframe } from './types';
import { chicagoOffsetSeconds, getChicagoParts, tradeDateWeekday, weekdayIndex } from './time';

/**
 * Session buckets in America/Chicago local time:
 * - asia: 17:00–02:59 (Globex reopen / Asia hours)
 * - europe: 03:00–08:29
 * - america_rth: 08:30–14:59 (US cash equity hours, 09:30–16:00 ET)
 * - america_eth: 15:00–16:59 (futures trade on after the cash close until the 16:00 CT halt)
 */
export function sessionBucket(unixSec: number): SessionBucket {
  const local = unixSec + chicagoOffsetSeconds(unixSec);
  const wrapped = local % 86400;
  const sod = wrapped >= 0 ? wrapped : wrapped + 86400;
  const m = Math.floor(sod / 60);
  if (m >= 17 * 60 || m < 3 * 60) return 'asia';
  if (m < 8 * 60 + 30) return 'europe';
  if (m < 15 * 60) return 'america_rth';
  return 'america_eth';
}

/** Daily rounds are decided at the 17:00 CT session open, so session filters do not apply to them. */
export function sessionFilterApplies(playTf: Timeframe): boolean {
  return playTf !== '1d';
}

/**
 * Round metadata at the decision time `cutoff` (open of the predicted bar).
 * Daily bars open at 17:00 CT the day before their trade date, so their weekday is the trade date's.
 */
export function decisionMeta(
  cutoff: number,
  playTf: Timeframe,
): { session: SessionBucket; hour: number; dayOfWeek: number } {
  return {
    session: sessionBucket(cutoff),
    hour: getChicagoParts(cutoff).hour,
    dayOfWeek: playTf === '1d' ? tradeDateWeekday(cutoff) : weekdayIndex(cutoff),
  };
}

export const SESSION_LABELS: Record<SessionBucket, string> = {
  asia: '亚洲时段',
  europe: '欧洲时段',
  america_rth: '美洲RTH',
  america_eth: '美洲ETH',
};

export const SESSION_HOURS: Record<SessionBucket, string> = {
  asia: '17:00–02:59',
  europe: '03:00–08:29',
  america_rth: '08:30–14:59',
  america_eth: '15:00–16:59',
};
