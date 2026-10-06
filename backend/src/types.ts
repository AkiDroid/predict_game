import type { DatabaseSync } from 'node:sqlite';
import type { GameEngine } from '../gameEngine.ts';
import type { SessionStore } from './modules/auth/sessionStore.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseSync;
    sessions: SessionStore;
    engine: GameEngine;
    marketReady: boolean;
    marketError: string;
  }

  interface FastifyRequest {
    /** Null until the auth plugin loads a session from Redis. */
    userId: string | null;
    username: string | null;
    displayName: string | null;
  }
}
