import { createClient, type RedisClientType } from 'redis';

export interface SessionData {
  userId: string;
}

export interface SessionStore {
  get(id: string): Promise<SessionData | null>;
  set(id: string, data: SessionData, ttlSec: number): Promise<void>;
  del(id: string): Promise<void>;
  close(): Promise<void>;
}

const KEY_PREFIX = 'sess:';

export function createMemorySessionStore(): SessionStore {
  const map = new Map<string, { data: SessionData; expiresAt: number }>();

  return {
    async get(id) {
      const row = map.get(id);
      if (!row) return null;
      if (row.expiresAt <= Date.now()) {
        map.delete(id);
        return null;
      }
      return row.data;
    },
    async set(id, data, ttlSec) {
      map.set(id, { data, expiresAt: Date.now() + ttlSec * 1000 });
    },
    async del(id) {
      map.delete(id);
    },
    async close() {
      map.clear();
    },
  };
}

export async function createRedisSessionStore(options: {
  host: string;
  port: number;
  password?: string;
  db: number;
}): Promise<SessionStore> {
  const client: RedisClientType = createClient({
    socket: {
      host: options.host,
      port: options.port,
    },
    password: options.password || undefined,
    database: options.db,
  });
  client.on('error', (err) => {
    console.error('redis error', err);
  });
  await client.connect();

  return {
    async get(id) {
      const raw = await client.get(`${KEY_PREFIX}${id}`);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as SessionData;
        if (!parsed || typeof parsed.userId !== 'string') return null;
        return { userId: parsed.userId };
      } catch {
        return null;
      }
    },
    async set(id, data, ttlSec) {
      await client.set(`${KEY_PREFIX}${id}`, JSON.stringify(data), { EX: ttlSec });
    },
    async del(id) {
      await client.del(`${KEY_PREFIX}${id}`);
    },
    async close() {
      if (client.isOpen) await client.quit();
    },
  };
}
