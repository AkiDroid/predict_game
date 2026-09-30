import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  processedDir: string;
  distDir: string;
  corsOrigin: string;
  serveStatic: boolean;
}

export function findRepoRoot(): string {
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (
        fs.existsSync(path.join(dir, 'package.json')) &&
        fs.existsSync(path.join(dir, 'backend', 'src'))
      ) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('找不到项目根目录');
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const root = findRepoRoot();
  const lifecycle = process.env.npm_lifecycle_event ?? '';
  const serveUi =
    process.env.SERVE_STATIC === '1' || lifecycle === 'start' || lifecycle === 'preview';
  const distDir = path.join(root, 'dist');
  const config: AppConfig = {
    host: process.env.HOST ?? '127.0.0.1',
    port: readPort(serveUi ? 5173 : 3001),
    databasePath: process.env.DATABASE_PATH ?? path.join(root, 'data', 'app.sqlite'),
    processedDir: process.env.PROCESSED_DIR ?? path.join(root, 'data', 'processed'),
    distDir,
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    serveStatic: serveUi && fs.existsSync(path.join(distDir, 'index.html')),
  };
  return { ...config, ...overrides };
}

function readPort(fallback: number): number {
  if (!process.env.PORT) return fallback;
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效端口: ${process.env.PORT}`);
  }
  return port;
}
