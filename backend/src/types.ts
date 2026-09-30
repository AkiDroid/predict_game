import type { DatabaseSync } from 'node:sqlite';
import type { GameEngine } from '../gameEngine.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseSync;
    engine: GameEngine;
    marketReady: boolean;
    marketError: string;
  }

  interface FastifyRequest {
    /** Null until the auth plugin loads a session. */
    userId: string | null;
  }
}
