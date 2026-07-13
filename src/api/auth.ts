import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AuthRequest, createLegacyAuthMiddleware } from '../middleware/auth';
import { createMemoryRateLimiter } from '../middleware/rate-limit';

interface LegacyAuthRouterDependencies {
  db?: Database.Database;
  config?: AppConfig;
}

export function createAuthRouter(
  dependencies: LegacyAuthRouterDependencies = {},
): Router {
  const router = Router();
  const database = (): Database.Database => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const authLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 10,
    message: 'Too many authentication attempts',
  });

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post(
    '/register',
    ...(runtimeConfig.rateLimitEnabled ? [authLimiter] : []),
    (req, res) => {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
      const db = database();
      const count = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
      if (count.c === 0) {
        return res.status(409).json({
          error: 'Initialize the first administrator through /api/v1/auth/bootstrap',
        });
      }
      const settings = db.prepare(
        'SELECT registration_enabled FROM server_settings WHERE id = 1',
      ).get() as { registration_enabled: number };
      if (!settings.registration_enabled) {
        return res.status(403).json({ error: 'Registration disabled' });
      }
      if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        return res.status(409).json({ error: 'Username taken' });
      }
      const id = randomUUID();
      const hash = bcrypt.hashSync(password, 10);
      const now = new Date().toISOString();
      const role = 'user';
      db.prepare(`
        INSERT INTO users (
          id, username, password_hash, role, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, username, hash, role, now, now);
      const token = jwt.sign(
        { userId: id, role, type: 'legacy' },
        runtimeConfig.jwtSecret,
        {
          algorithm: 'HS256',
          issuer: runtimeConfig.jwtIssuer,
          audience: 'openlogtool-legacy',
          expiresIn: 86_400,
        },
      );
      res.json({ token, user: { id, username, role } });
    },
  );

  router.post(
    '/login',
    ...(runtimeConfig.rateLimitEnabled ? [authLimiter] : []),
    (req, res) => {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
      const db = database();
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
        | {
            id: string;
            username: string;
            password_hash: string;
            role: string;
            disabled_at: string | null;
            deleted_at: string | null;
            must_change_password: number;
          }
        | undefined;
      if (!user || user.deleted_at || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      if (user.disabled_at) return res.status(403).json({ error: 'Account disabled' });
      if (Number(user.must_change_password) === 1) {
        return res.status(403).json({
          error: 'Change the temporary password through /api/v1/auth/login',
        });
      }
      const token = jwt.sign(
        { userId: user.id, role: user.role, type: 'legacy' },
        runtimeConfig.jwtSecret,
        {
          algorithm: 'HS256',
          issuer: runtimeConfig.jwtIssuer,
          audience: 'openlogtool-legacy',
          expiresIn: 86_400,
        },
      );
      res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    },
  );

  router.get(
    '/me',
    createLegacyAuthMiddleware(runtimeConfig),
    (req: AuthRequest, res) => {
      const user = database()
        .prepare('SELECT id, username, role FROM users WHERE id = ?')
        .get(req.userId);
      res.json(user);
    },
  );

  return router;
}

export const authRouter = createAuthRouter();
