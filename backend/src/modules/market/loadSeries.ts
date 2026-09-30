import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { BarSeries } from '../../../binary.ts';
import { GameEngine } from '../../../gameEngine.ts';
import type { SymbolId } from '../../../../src/lib/types.ts';
import { TIMEFRAMES } from '../../../../src/lib/types.ts';

const SYMBOLS: SymbolId[] = ['ES', 'NQ'];

export function loadMarketData(
  engine: GameEngine,
  db: DatabaseSync,
  processedDir: string,
): { ok: boolean; error?: string; loaded: number } {
  if (!fs.existsSync(processedDir)) {
    return {
      ok: false,
      error: `未找到预处理数据目录 ${processedDir}。请先运行: npm run preprocess`,
      loaded: 0,
    };
  }

  const upsert = db.prepare(`
    INSERT INTO series_catalog (symbol, timeframe, bar_count, t_from, t_to, loaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, timeframe) DO UPDATE SET
      bar_count = excluded.bar_count,
      t_from = excluded.t_from,
      t_to = excluded.t_to,
      loaded_at = excluded.loaded_at
  `);

  let loaded = 0;
  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      const file = path.join(processedDir, symbol, `${tf}.bin`);
      if (!fs.existsSync(file)) {
        return { ok: false, error: `缺少文件: ${file}`, loaded };
      }
      const buf = fs.readFileSync(file);
      engine.setSeries(symbol, tf, BarSeries.fromBuffer(buf));
      const meta = engine.getMeta(symbol, tf);
      upsert.run(symbol, tf, meta.count, meta.from, meta.to, Date.now());
      loaded++;
    }
  }
  return { ok: true, loaded };
}
