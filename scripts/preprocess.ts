/**
 * Stream-parse 1-minute TXT → resample all TFs → write compact PBAR binaries.
 * Usage: npx tsx scripts/preprocess.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { encodeBars } from '../backend/binary.ts';
import { resampleOHLCV } from '../src/lib/resample.ts';
import { parseDataTimestamp } from '../src/lib/time.ts';
import type { Bar, SymbolId, Timeframe } from '../src/lib/types.ts';
import { TIMEFRAMES } from '../src/lib/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'processed');

async function parse1m(filePath: string): Promise<Bar[]> {
  const bars: Bar[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  let dropped = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',');
    if (parts.length < 7) {
      throw new Error(`${filePath}:${lineNo} bad columns: ${trimmed.slice(0, 80)}`);
    }
    const [date, time, o, h, l, c, v] = parts;
    const t = parseDataTimestamp(date, time);
    const prev = bars[bars.length - 1];
    if (prev && t <= prev.t) {
      // Repeated wall-clock minutes (DST fall-back) would break the sorted series.
      dropped++;
      continue;
    }
    bars.push({
      t,
      o: Number(o),
      h: Number(h),
      l: Number(l),
      c: Number(c),
      v: Number(v),
    });
    if (lineNo % 500_000 === 0) {
      console.log(`  ... ${lineNo.toLocaleString()} lines`);
    }
  }
  if (dropped) console.warn(`  dropped ${dropped} out-of-order rows`);
  return bars;
}

async function processSymbol(symbol: SymbolId): Promise<void> {
  const src = path.join(DATA, `${symbol}_1min.txt`);
  if (!fs.existsSync(src)) throw new Error(`Missing ${src}`);
  console.log(`\n[${symbol}] reading ${src}`);
  const t0 = Date.now();
  const bars1m = await parse1m(src);
  console.log(`[${symbol}] ${bars1m.length.toLocaleString()} 1m bars in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (bars1m.length) {
    console.log(
      `[${symbol}] range ${new Date(bars1m[0].t * 1000).toISOString()} → ${new Date(bars1m[bars1m.length - 1].t * 1000).toISOString()}`,
    );
  }

  const dir = path.join(OUT, symbol);
  fs.mkdirSync(dir, { recursive: true });

  for (const tf of TIMEFRAMES as Timeframe[]) {
    const t1 = Date.now();
    const bars = tf === '1m' ? bars1m : resampleOHLCV(bars1m, tf);
    const buf = encodeBars(symbol, tf, bars);
    const outFile = path.join(dir, `${tf}.bin`);
    fs.writeFileSync(outFile, buf);
    console.log(
      `[${symbol}] ${tf}: ${bars.length.toLocaleString()} bars → ${(buf.length / 1024 / 1024).toFixed(1)} MB (${Date.now() - t1}ms)`,
    );
  }

  // Meta JSON
  const meta = {
    symbol,
    sourceTimezone: 'America/New_York',
    timezone: 'America/Chicago',
    session:
      'CME Globex; raw rows are US Eastern wall time, stored as UTC; trade date rolls at 17:00 CT; ' +
      'RTH 08:30–15:00 CT, daily halt 16:00–17:00 CT; 4h bars anchor at 17:00 CT; daily bars aggregate session open→close',
    count1m: bars1m.length,
    from: bars1m[0]?.t ?? 0,
    to: bars1m[bars1m.length - 1]?.t ?? 0,
    timeframes: TIMEFRAMES,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const symbol of ['ES', 'NQ'] as SymbolId[]) {
    await processSymbol(symbol);
  }
  console.log('\nDone. Output:', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
