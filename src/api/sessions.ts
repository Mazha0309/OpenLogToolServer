import { Router } from 'express';
import { getDb } from '../db/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const sessionsRouter = Router();
sessionsRouter.use(authMiddleware);

sessionsRouter.get('/', (req: AuthRequest, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM sessions WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(req.userId);
  res.json(rows);
});

sessionsRouter.post('/', (req: AuthRequest, res) => {
  const { id, title, status = 'active' } = req.body;
  if (!id || !title) return res.status(400).json({ error: 'Missing id or title' });
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare('INSERT INTO sessions (id, title, status, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, title, status, req.userId, now, now);
  res.status(201).json({ id, title, status });
});

sessionsRouter.get('/:id', (req: AuthRequest, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as any;
  if (!session || session.owner_user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
  const logs = db.prepare('SELECT * FROM logs WHERE session_id = ? AND deleted_at IS NULL ORDER BY time ASC').all(req.params.id);
  res.json({ ...session, logs });
});

sessionsRouter.put('/:id', (req: AuthRequest, res) => {
  const { title, status } = req.body;
  const now = new Date().toISOString();
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as any;
  if (!session || session.owner_user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE sessions SET title = COALESCE(?, title), status = COALESCE(?, status), updated_at = ? WHERE id = ?').run(title ?? null, status ?? null, now, req.params.id);
  res.json({ ...session, ...(title ? { title } : {}), ...(status ? { status } : {}), updated_at: now });
});

sessionsRouter.delete('/:id', (req: AuthRequest, res) => {
  const now = new Date().toISOString();
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as any;
  if (!session || session.owner_user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, req.params.id);
  res.json({ ok: true });
});
