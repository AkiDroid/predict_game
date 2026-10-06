/**
 * Indices of a polyline worth drawing at `columns` pixels wide: per pixel bucket the first, lowest,
 * highest and last point, in index order. Below ~4 points per column every index is kept.
 */
export function decimatedIndices(n: number, columns: number, valueAt: (i: number) => number): number[] {
  const cols = Math.max(1, Math.floor(columns));
  if (n <= cols * 4) {
    const all = new Array<number>(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return all;
  }
  const out: number[] = [];
  for (let b = 0; b < cols; b++) {
    const start = Math.floor((b * n) / cols);
    const end = Math.floor(((b + 1) * n) / cols);
    if (end <= start) continue;
    let lo = start;
    let hi = start;
    for (let i = start + 1; i < end; i++) {
      const v = valueAt(i);
      if (v < valueAt(lo)) lo = i;
      if (v > valueAt(hi)) hi = i;
    }
    const picks = [start, lo, hi, end - 1].sort((a, c) => a - c);
    for (let k = 0; k < picks.length; k++) {
      if (k === 0 || picks[k] !== picks[k - 1]) out.push(picks[k]);
    }
  }
  return out;
}
