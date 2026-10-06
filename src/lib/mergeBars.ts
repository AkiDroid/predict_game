import type { Bar } from './types';

/**
 * Union of two bar windows by open time, ascending. For equal `t` the bar from
 * `winner` replaces the one from `base`. An empty side returns the other array as is.
 */
export function mergeBars(base: Bar[], winner: Bar[]): Bar[] {
  if (!base.length) return winner;
  if (!winner.length) return base;
  if (!strictlyAscending(base) || !strictlyAscending(winner)) return mergeBySort(base, winner);
  if (base[base.length - 1].t < winner[0].t) return base.concat(winner);
  if (winner[winner.length - 1].t < base[0].t) return winner.concat(base);
  return mergeSorted(base, winner);
}

function strictlyAscending(bars: Bar[]): boolean {
  for (let i = 1; i < bars.length; i++) {
    if (!(bars[i - 1].t < bars[i].t)) return false;
  }
  return true;
}

function mergeSorted(base: Bar[], winner: Bar[]): Bar[] {
  const out: Bar[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length && j < winner.length) {
    const a = base[i];
    const b = winner[j];
    if (a.t < b.t) {
      out.push(a);
      i++;
    } else if (b.t < a.t) {
      out.push(b);
      j++;
    } else {
      out.push(b);
      i++;
      j++;
    }
  }
  while (i < base.length) out.push(base[i++]);
  while (j < winner.length) out.push(winner[j++]);
  return out;
}

function mergeBySort(base: Bar[], winner: Bar[]): Bar[] {
  const map = new Map<number, Bar>();
  for (const bar of base) map.set(bar.t, bar);
  for (const bar of winner) map.set(bar.t, bar);
  return [...map.values()].sort((a, b) => a.t - b.t);
}
