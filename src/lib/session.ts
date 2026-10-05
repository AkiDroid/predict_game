import type { SessionBucket } from './types';
import { chicagoOffsetSeconds } from './time';

/**
 * Session buckets in America/Chicago local time:
 * - asia: 17:00–02:59 (evening Globex / Asia overlap)
 * - europe: 03:00–08:29
 * - america_rth: 08:30–15:59 (approximate US cash equity hours)
 * - america_eth: 16:00–16:59 (post-RTH before daily break)
 */
export function sessionBucket(unixSec: number): SessionBucket {
  const local = unixSec + chicagoOffsetSeconds(unixSec);
  const wrapped = local % 86400;
  const sod = wrapped >= 0 ? wrapped : wrapped + 86400;
  const m = Math.floor(sod / 60);
  if (m >= 17 * 60 || m < 3 * 60) return 'asia';
  if (m < 8 * 60 + 30) return 'europe';
  if (m < 16 * 60) return 'america_rth';
  return 'america_eth';
}

export const SESSION_LABELS: Record<SessionBucket, string> = {
  asia: '亚洲时段',
  europe: '欧洲时段',
  america_rth: '美洲RTH',
  america_eth: '美洲ETH',
};
