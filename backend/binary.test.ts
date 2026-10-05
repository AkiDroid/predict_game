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
  });
});
