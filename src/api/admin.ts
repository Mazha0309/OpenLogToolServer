import { Router } from 'express';
import { getDb } from '../db/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';

export const adminRouter = Router();
adminRouter.use(authMiddleware, adminMiddleware as any);

adminRouter.get('/settings', (_, res) => {
  const db = getDb();
  const row = db.prepare('SELECT registration_enabled FROM server_settings WHERE id = 1').get() as any;
  res.json(row);
});

adminRouter.put('/settings', (req, res) => {
  const { registration_enabled } = req.body;
  const db = getDb();
  db.prepare('UPDATE server_settings SET registration_enabled = ? WHERE id = 1').run(registration_enabled ? 1 : 0);
  res.json({ registration_enabled: registration_enabled ? 1 : 0 });
});

adminRouter.get('/users', (_, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});
