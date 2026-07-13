import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { Router } from 'express';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import {
  authMiddleware,
  AuthRequest,
  createLegacyAuthMiddleware,
} from '../middleware/auth';
import { adminMiddleware, createAdminMiddleware } from '../middleware/admin';
import { getRequestId } from '../middleware/request-id';

interface AdminRouterDependencies {
  db?: Database.Database;
  config?: AppConfig;
}

export function createAdminRouter(dependencies: AdminRouterDependencies = {}): Router {
  const router = Router();
  const db = dependencies.db;
  const runtimeConfig = dependencies.config;
  const database = (): Database.Database => db ?? getDb();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(
    runtimeConfig ? createLegacyAuthMiddleware(runtimeConfig) : authMiddleware,
    db ? createAdminMiddleware(db) : adminMiddleware,
  );

  router.get('/settings', (_, res) => {
    const row = database()
      .prepare('SELECT registration_enabled FROM server_settings WHERE id = 1')
      .get();
    res.json(row);
  });

  router.put('/settings', (req: AuthRequest, res) => {
    const body = req.body as unknown;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as Record<string, unknown>).registration_enabled !== 'boolean'
    ) {
      res.status(400).json({ error: 'Expected only a boolean registration_enabled field' });
      return;
    }
    const registrationEnabled = (body as { registration_enabled: boolean }).registration_enabled;
    const nextValue = registrationEnabled ? 1 : 0;
    const db = database();
    const updateSettings = db.transaction(() => {
      const actor = req.userId
        ? db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as
            | { role: string }
            | undefined
        : undefined;
      if (req.userRole !== 'admin' || actor?.role !== 'admin') return false;
      const row = db.prepare(
        'SELECT registration_enabled FROM server_settings WHERE id = 1',
      ).get() as { registration_enabled: number } | undefined;
      if (!row) throw new Error('Server settings are not initialized');
      if (row.registration_enabled !== 0 && row.registration_enabled !== 1) {
        throw new Error('Server registration setting is invalid');
      }
      if (row.registration_enabled !== nextValue) {
        const occurredAt = new Date().toISOString();
        db.prepare(
          'UPDATE server_settings SET registration_enabled = ? WHERE id = 1',
        ).run(nextValue);
        db.prepare(`
          INSERT INTO admin_audit_events (
            id, action, actor_user_id, target_user_id, request_id, mutation_id,
            before_json, after_json, details_json, occurred_at
          ) VALUES (?, 'settings.registration.updated', ?, NULL, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          req.userId,
          getRequestId(req),
          `legacy/${randomUUID()}`,
          JSON.stringify({ registrationEnabled: row.registration_enabled === 1 }),
          JSON.stringify({ registrationEnabled: nextValue === 1 }),
          JSON.stringify({ source: 'legacy-admin-api' }),
          occurredAt,
        );
      }
      return true;
    });
    if (!updateSettings.immediate()) {
      res.status(403).json({ error: 'Admin only' });
      return;
    }
    res.json({ registration_enabled: nextValue });
  });

  router.get('/users', (_, res) => {
    const users = database()
      .prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC')
      .all();
    res.json(users);
  });

  return router;
}

export const adminRouter = createAdminRouter({ config });
