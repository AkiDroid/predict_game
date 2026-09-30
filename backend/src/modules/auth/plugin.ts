import fp from 'fastify-plugin';

/**
 * Login is not implemented.
 *
 * `users` and `sessions` already exist (backend/src/db/migrations/001_init.sql).
 * `rounds.user_id` is nullable so a later login can stamp the player without a new table.
 * Game routes already pass `request.userId` into round creation; this hook leaves it null.
 *
 * When accounts are added, replace the body of the hook below:
 * 1. Hash passwords with scrypt or argon2. Never store the raw password.
 * 2. Add POST /api/auth/register and POST /api/auth/login on this plugin.
 * 3. Set an httpOnly session cookie. Store only token_hash in `sessions`.
 * 4. Load that session here and assign request.userId.
 * Keep CORS credentials enabled; the origin is already explicit.
 */
export const authPlugin = fp(
  async (app) => {
    app.decorateRequest('userId', null);
    app.addHook('onRequest', async (request) => {
      request.userId = null;
    });
  },
  { name: 'auth', dependencies: ['db'] },
);
