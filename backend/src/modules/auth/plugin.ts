import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { clearCookie, parseCookies, serializeCookie, SESSION_COOKIE } from './cookies.ts';
import { hashPassword, verifyPassword } from './password.ts';

const USERNAME_RE = /^[\w\u4e00-\u9fff-]{3,32}$/;

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.userId) {
    return reply.status(401).send({ error: '未登录' });
  }
}

export const authPlugin = fp(
  async (app, opts: { sessionTtlSec: number; cookieSecure: boolean }) => {
    app.decorateRequest('userId', null);
    app.decorateRequest('username', null);
    app.decorateRequest('displayName', null);

    const userByIdStmt = app.db.prepare('SELECT id, email, display_name FROM users WHERE id = ?');
    const userIdByNameStmt = app.db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE');
    const loginRowStmt = app.db.prepare(
      'SELECT id, email, password_hash, display_name FROM users WHERE email = ? COLLATE NOCASE',
    );
    const insertUserStmt = app.db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    app.addHook('onRequest', async (request) => {
      request.userId = null;
      request.username = null;
      request.displayName = null;
      // Static assets and the SPA fallback never need a session.
      if (!request.url.startsWith('/api')) return;
      const sid = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (!sid) return;
      const session = await app.sessions.get(sid);
      if (!session) return;
      const row = userByIdStmt.get(session.userId) as
        | { id: string; email: string; display_name: string }
        | undefined;
      if (!row) {
        await app.sessions.del(sid);
        return;
      }
      request.userId = row.id;
      request.username = row.email;
      request.displayName = row.display_name;
    });

    app.post(
      '/api/auth/register',
      {
        schema: {
          body: {
            type: 'object',
            required: ['username', 'password'],
            additionalProperties: false,
            properties: {
              username: { type: 'string', minLength: 3, maxLength: 32 },
              password: { type: 'string', minLength: 8, maxLength: 128 },
            },
          },
        },
      },
      async (request, reply) => {
        const body = request.body as { username: string; password: string };
        const username = body.username.trim();
        const password = body.password;
        const err = validateCredentials(username, password);
        if (err) return reply.status(400).send({ error: err });

        const existing = userIdByNameStmt.get(username);
        if (existing) return reply.status(409).send({ error: '用户名已存在' });

        const id = randomUUID();
        const now = Date.now();
        const passwordHash = await hashPassword(password);
        try {
          insertUserStmt.run(id, username, passwordHash, username, now, now);
        } catch {
          return reply.status(409).send({ error: '用户名已存在' });
        }

        await createSession(app, reply, id, opts);
        return { user: { id, username, displayName: username } };
      },
    );

    app.post(
      '/api/auth/login',
      {
        schema: {
          body: {
            type: 'object',
            required: ['username', 'password'],
            additionalProperties: false,
            properties: {
              username: { type: 'string', minLength: 1, maxLength: 32 },
              password: { type: 'string', minLength: 1, maxLength: 128 },
            },
          },
        },
      },
      async (request, reply) => {
        const body = request.body as { username: string; password: string };
        const username = body.username.trim();
        const row = loginRowStmt.get(username) as
          | { id: string; email: string; password_hash: string; display_name: string }
          | undefined;
        if (!row || !(await verifyPassword(body.password, row.password_hash))) {
          return reply.status(401).send({ error: '用户名或密码错误' });
        }
        await createSession(app, reply, row.id, opts);
        return {
          user: { id: row.id, username: row.email, displayName: row.display_name },
        };
      },
    );

    app.post('/api/auth/logout', async (request, reply) => {
      const sid = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (sid) await app.sessions.del(sid);
      reply.header(
        'Set-Cookie',
        clearCookie(SESSION_COOKIE, { sameSite: 'Lax', secure: opts.cookieSecure }),
      );
      return { ok: true };
    });

    app.get('/api/auth/me', async (request, reply) => {
      if (!request.userId) return reply.status(401).send({ error: '未登录' });
      return {
        user: {
          id: request.userId,
          username: request.username,
          displayName: request.displayName,
        },
      };
    });
  },
  { name: 'auth', dependencies: ['db', 'redis'] },
);

function validateCredentials(username: string, password: string): string | null {
  if (!USERNAME_RE.test(username)) {
    return '用户名需为 3–32 位字母、数字、下划线、连字符或中文';
  }
  if (password.length < 8 || password.length > 128) {
    return '密码长度需为 8–128 位';
  }
  return null;
}

async function createSession(
  app: FastifyInstance,
  reply: FastifyReply,
  userId: string,
  opts: { sessionTtlSec: number; cookieSecure: boolean },
) {
  const sid = randomUUID();
  await app.sessions.set(sid, { userId }, opts.sessionTtlSec);
  reply.header(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: opts.cookieSecure,
      path: '/',
      maxAge: opts.sessionTtlSec,
    }),
  );
}
