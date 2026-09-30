import type { Bar } from '../src/lib/types.ts';

const MAGIC = 0x50424152; // PBAR

export function encodeBars(symbol: string, tf: string, bars: Bar[]): Buffer {
  const symBuf = Buffer.from(symbol, 'utf8');
  const tfBuf = Buffer.from(tf, 'utf8');
  const count = bars.length;
  const headerSize = 4 + 4 + 4 + 4 + symBuf.length + 4 + tfBuf.length;
  const bodySize = count * (4 + 4 * 5);
  const buf = Buffer.alloc(headerSize + bodySize);
  let o = 0;
  buf.writeUInt32LE(MAGIC, o); o += 4;
  buf.writeUInt32LE(1, o); o += 4;
  buf.writeUInt32LE(count, o); o += 4;
  buf.writeUInt32LE(symBuf.length, o); o += 4;
  symBuf.copy(buf, o); o += symBuf.length;
  buf.writeUInt32LE(tfBuf.length, o); o += 4;
  tfBuf.copy(buf, o); o += tfBuf.length;

  for (let i = 0; i < count; i++) buf.writeInt32LE(bars[i].t, o + i * 4);
  o += count * 4;
  for (let i = 0; i < count; i++) buf.writeFloatLE(bars[i].o, o + i * 4);
  o += count * 4;
  for (let i = 0; i < count; i++) buf.writeFloatLE(bars[i].h, o + i * 4);
  o += count * 4;
  for (let i = 0; i < count; i++) buf.writeFloatLE(bars[i].l, o + i * 4);
  o += count * 4;
  for (let i = 0; i < count; i++) buf.writeFloatLE(bars[i].c, o + i * 4);
  o += count * 4;
  for (let i = 0; i < count; i++) buf.writeFloatLE(bars[i].v, o + i * 4);
  return buf;
}

export function decodeBars(buf: Buffer): { symbol: string; tf: string; bars: Bar[] } {
  let o = 0;
  const magic = buf.readUInt32LE(o); o += 4;
  if (magic !== MAGIC) throw new Error('Invalid PBAR magic');
  const version = buf.readUInt32LE(o); o += 4;
  if (version !== 1) throw new Error(`Unsupported PBAR version ${version}`);
  const count = buf.readUInt32LE(o); o += 4;
  const symLen = buf.readUInt32LE(o); o += 4;
  const symbol = buf.subarray(o, o + symLen).toString('utf8'); o += symLen;
  const tfLen = buf.readUInt32LE(o); o += 4;
  const tf = buf.subarray(o, o + tfLen).toString('utf8'); o += tfLen;

  const times = new Int32Array(count);
  for (let i = 0; i < count; i++) times[i] = buf.readInt32LE(o + i * 4);
  o += count * 4;
  const opens = new Float32Array(count);
  for (let i = 0; i < count; i++) opens[i] = buf.readFloatLE(o + i * 4);
  o += count * 4;
  const highs = new Float32Array(count);
  for (let i = 0; i < count; i++) highs[i] = buf.readFloatLE(o + i * 4);
  o += count * 4;
  const lows = new Float32Array(count);
  for (let i = 0; i < count; i++) lows[i] = buf.readFloatLE(o + i * 4);
  o += count * 4;
  const closes = new Float32Array(count);
  for (let i = 0; i < count; i++) closes[i] = buf.readFloatLE(o + i * 4);
  o += count * 4;
  const vols = new Float32Array(count);
  for (let i = 0; i < count; i++) vols[i] = buf.readFloatLE(o + i * 4);

  const bars: Bar[] = new Array(count);
  for (let i = 0; i < count; i++) {
    bars[i] = { t: times[i], o: opens[i], h: highs[i], l: lows[i], c: closes[i], v: vols[i] };
  }
  return { symbol, tf, bars };
}

/** Compact in-memory columnar store for fast slicing. */
export class BarSeries {
  readonly t: Int32Array;
  readonly o: Float32Array;
  readonly h: Float32Array;
  readonly l: Float32Array;
  readonly c: Float32Array;
  readonly v: Float32Array;
  readonly length: number;

  constructor(bars: Bar[]) {
    const n = bars.length;
    this.length = n;
    this.t = new Int32Array(n);
    this.o = new Float32Array(n);
    this.h = new Float32Array(n);
    this.l = new Float32Array(n);
    this.c = new Float32Array(n);
    this.v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      this.t[i] = b.t;
      this.o[i] = b.o;
      this.h[i] = b.h;
      this.l[i] = b.l;
      this.c[i] = b.c;
      this.v[i] = b.v;
    }
  }

  static fromBuffer(buf: Buffer): BarSeries {
    return new BarSeries(decodeBars(buf).bars);
  }

  at(i: number): Bar {
    return {
      t: this.t[i],
      o: this.o[i],
      h: this.h[i],
      l: this.l[i],
      c: this.c[i],
      v: this.v[i],
    };
  }

  slice(from: number, to: number): Bar[] {
    const out: Bar[] = [];
    const a = Math.max(0, from);
    const b = Math.min(this.length, to);
    for (let i = a; i < b; i++) out.push(this.at(i));
    return out;
  }

  /** Last index with t <= time, or -1. */
  indexAtOrBefore(time: number): number {
    let lo = 0;
    let hi = this.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] <= time) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** First index with t >= time, or length. */
  indexAtOrAfter(time: number): number {
    let lo = 0;
    let hi = this.length - 1;
    let ans = this.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] >= time) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }
}
