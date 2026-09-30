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
  redisHost: string;
  redisPort: number;
  redisPassword: string;
  redisDb: number;
  sessionTtlSec: number;
  cookieSecure: boolean;
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
    redisHost: process.env.REDIS_HOST ?? '127.0.0.1',
    redisPort: readInt(process.env.REDIS_PORT, 6379),
    redisPassword: process.env.REDIS_PASSWORD ?? '',
    redisDb: readInt(process.env.REDIS_DB, 0),
    sessionTtlSec: readInt(process.env.SESSION_TTL_SEC, 60 * 60 * 24 * 7),
    cookieSecure: process.env.COOKIE_SECURE === '1',
  };
  return { ...config, ...overrides };
}

function readInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`无效整数环境变量: ${raw}`);
  }
  return n;
}

function readPort(fallback: number): number {
  if (!process.env.PORT) return fallback;
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效端口: ${process.env.PORT}`);
  }
  return port;
}
