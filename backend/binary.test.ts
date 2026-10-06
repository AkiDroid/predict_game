import { describe, expect, it } from 'vitest';
import { BarSeries, decodeBars, encodeBars } from './binary.ts';
import type { Bar } from '../src/lib/types.ts';

function bars(count: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      t: 1_700_000_000 + i * 60,
      o: 100 + i * 0.25,
      h: 101.5 + i * 0.25,
      l: 99.25 + i * 0.25,
      c: 100.75 + i * 0.25,
      v: i + 0.5,
    });
  }
  return out;
}

function expectSameSeries(buf: Buffer): void {
  const viaObjects = new BarSeries(decodeBars(buf).bars);
  const direct = BarSeries.fromBuffer(buf);
  expect(direct.length).toBe(viaObjects.length);
  for (let i = 0; i < direct.length; i++) expect(direct.at(i)).toEqual(viaObjects.at(i));
}

describe('BarSeries.fromBuffer', () => {
  it('matches the object decoder for aligned and unaligned columns', () => {
    const aligned = encodeBars('ES', '1m', bars(200));
    const unaligned = encodeBars('ES', '15m', bars(200));
    expect(aligned.byteOffset % 4).toBe(0);
    expect((unaligned.byteOffset + 25) % 4).not.toBe(0);
    expectSameSeries(aligned);
    expectSameSeries(unaligned);
    expect(decodeBars(aligned)).toMatchObject({ symbol: 'ES', tf: '1m' });
  });

  it('reads an empty series', () => {
    const buf = encodeBars('NQ', '1h', []);
    expect(BarSeries.fromBuffer(buf).length).toBe(0);
    expect(decodeBars(buf).bars).toEqual([]);
    expect(BarSeries.fromBuffer(encodeBars('NQ', '30m', [])).length).toBe(0);
  });

  it('views aligned columns in place and copies unaligned ones once', () => {
    const aligned = encodeBars('ES', '1m', bars(50));
    const view = BarSeries.fromBuffer(aligned);
    expect(view.t.buffer).toBe(aligned.buffer);
    expect(view.v.buffer).toBe(aligned.buffer);

    const unaligned = encodeBars('ES', '30m', bars(50));
    const copy = BarSeries.fromBuffer(unaligned);
    expect(copy.t.buffer).not.toBe(unaligned.buffer);
    expect(copy.o.buffer).toBe(copy.t.buffer);
    unaligned.fill(0);
    expect(copy.at(49)).toEqual(new BarSeries(bars(50)).at(49));
  });

  it('copies instead of pinning a small slice of a large ArrayBuffer', () => {
    const encoded = encodeBars('ES', '1m', bars(20));
    const big = Buffer.alloc(1 << 20);
    encoded.copy(big, 4096);
    const slice = big.subarray(4096, 4096 + encoded.length);
    const series = BarSeries.fromBuffer(slice);
    expect(series.t.buffer).not.toBe(big.buffer);
    expectSameSeries(slice);
  });

  it('reads pooled and odd-offset buffers', () => {
    const encoded = encodeBars('NQ', '4h', bars(30));
    const pooled = Buffer.allocUnsafe(encoded.length);
    encoded.copy(pooled);
    expectSameSeries(pooled);
    for (const shift of [1, 2, 3]) {
      const holder = Buffer.alloc(encoded.length + shift);
      encoded.copy(holder, shift);
      expectSameSeries(holder.subarray(shift));
    }
  });

  it('rejects a truncated body', () => {
    const buf = encodeBars('ES', '1m', bars(10));
    expect(() => BarSeries.fromBuffer(buf.subarray(0, buf.length - 1))).toThrow(RangeError);
  });

  it('encodes the same bytes as per-value little-endian writes', () => {
    const sample = bars(64).map((b, i) => ({ ...b, o: b.o + i / 3, v: i % 5 === 0 ? 0.1 * i : b.v, c: i === 7 ? -0 : b.c }));
    for (const tf of ['1m', '15m', '1d']) {
      expect(encodeBars('ES', tf, sample).equals(referenceEncode('ES', tf, sample))).toBe(true);
    }
    expect(() => encodeBars('ES', '1m', [{ ...sample[0]!, t: 2 ** 31 }])).toThrow(RangeError);
  });
});

function referenceEncode(symbol: string, tf: string, rows: Bar[]): Buffer {
  const symBuf = Buffer.from(symbol, 'utf8');
  const tfBuf = Buffer.from(tf, 'utf8');
  const header = 20 + symBuf.length + tfBuf.length;
  const buf = Buffer.alloc(header + rows.length * 24);
  let o = 0;
  o = buf.writeUInt32LE(0x50424152, o);
  o = buf.writeUInt32LE(1, o);
  o = buf.writeUInt32LE(rows.length, o);
  o = buf.writeUInt32LE(symBuf.length, o);
  o += symBuf.copy(buf, o);
  o = buf.writeUInt32LE(tfBuf.length, o);
  o += tfBuf.copy(buf, o);
  for (const r of rows) o = buf.writeInt32LE(r.t, o);
  for (const key of ['o', 'h', 'l', 'c', 'v'] as const) for (const r of rows) o = buf.writeFloatLE(r[key], o);
  return buf;
}
