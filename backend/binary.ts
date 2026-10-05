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

interface PbarHeader {
  symbol: string;
  tf: string;
  count: number;
  offset: number;
}

interface PackedColumns {
  t: Int32Array;
  o: Float32Array;
  h: Float32Array;
  l: Float32Array;
  c: Float32Array;
  v: Float32Array;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function readHeader(buf: Buffer): PbarHeader {
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
  return { symbol, tf, count, offset: o };
}

type ColumnCtor<T extends Int32Array | Float32Array> = {
  new (length: number): T;
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): T;
};

/** Copy one PBAR column. Aligned little-endian input is a single memcpy. */
function copyColumn<T extends Int32Array | Float32Array>(
  buf: Buffer,
  offset: number,
  count: number,
  Ctor: ColumnCtor<T>,
  read: (byteOffset: number) => number,
): T {
  const out = new Ctor(count);
  if (count === 0) return out;
  const nbytes = count * 4;
  if (offset < 0 || offset + nbytes > buf.length) throw new RangeError('truncated PBAR column');
  const start = buf.byteOffset + offset;
  if (LITTLE_ENDIAN && (start & 3) === 0) {
    out.set(new Ctor(buf.buffer, start, count));
    return out;
  }
  if (LITTLE_ENDIAN) {
    const bytes = new Uint8Array(count * 4);
    bytes.set(buf.subarray(offset, offset + count * 4));
    out.set(new Ctor(bytes.buffer, 0, count));
    return out;
  }
  for (let i = 0; i < count; i++) out[i] = read(offset + i * 4);
  return out;
}

function readColumns(buf: Buffer, offset: number, count: number): PackedColumns {
  let o = offset;
  const t = copyColumn(buf, o, count, Int32Array, (at) => buf.readInt32LE(at));
  o += count * 4;
  const open = copyColumn(buf, o, count, Float32Array, (at) => buf.readFloatLE(at));
  o += count * 4;
  const h = copyColumn(buf, o, count, Float32Array, (at) => buf.readFloatLE(at));
  o += count * 4;
  const l = copyColumn(buf, o, count, Float32Array, (at) => buf.readFloatLE(at));
  o += count * 4;
  const c = copyColumn(buf, o, count, Float32Array, (at) => buf.readFloatLE(at));
  o += count * 4;
  const v = copyColumn(buf, o, count, Float32Array, (at) => buf.readFloatLE(at));
  return { t, o: open, h, l, c, v };
}

export function decodeBars(buf: Buffer): { symbol: string; tf: string; bars: Bar[] } {
  const header = readHeader(buf);
  const cols = readColumns(buf, header.offset, header.count);
  const bars: Bar[] = new Array(header.count);
  for (let i = 0; i < header.count; i++) {
    bars[i] = { t: cols.t[i], o: cols.o[i], h: cols.h[i], l: cols.l[i], c: cols.c[i], v: cols.v[i] };
  }
  return { symbol: header.symbol, tf: header.tf, bars };
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

  constructor(bars: Bar[], packed?: PackedColumns) {
    if (packed) {
      this.length = packed.t.length;
      this.t = packed.t;
      this.o = packed.o;
      this.h = packed.h;
      this.l = packed.l;
      this.c = packed.c;
      this.v = packed.v;
      return;
    }
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
    const header = readHeader(buf);
    return new BarSeries([], readColumns(buf, header.offset, header.count));
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
