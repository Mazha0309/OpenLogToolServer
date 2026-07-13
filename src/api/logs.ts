import { Router } from 'express';
import { getDb } from '../db/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { broadcast } from '../ws';

export const logsRouter = Router();
logsRouter.use(authMiddleware);

// GET /api/sessions/:sessionId/logs
logsRouter.get('/:sessionId/logs', (req: AuthRequest, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(req.params.sessionId) as any;
  if (!session || session.owner_user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare('SELECT * FROM logs WHERE session_id = ? AND deleted_at IS NULL ORDER BY time ASC').all(req.params.sessionId);
  res.json(rows);
});

// POST /api/sessions/:sessionId/logs
logsRouter.post('/:sessionId/logs', (req: AuthRequest, res) => {
  const { sync_id, controller, callsign, time, rst_sent, rst_rcvd, qth, device, power, antenna, height } = req.body;
  if (!sync_id || !controller || !callsign || !time) return res.status(400).json({ error: 'Missing required fields' });
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(req.params.sessionId) as any;
  if (!session || session.owner_user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO logs (sync_id, session_id, controller, callsign, time, rst_sent, rst_rcvd, qth, device, power, antenna, height, created_at, updated_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sync_id, req.params.sessionId, controller, callsign, time, rst_sent ?? null, rst_rcvd ?? null, qth ?? null, device ?? null, power ?? null, antenna ?? null, height ?? null, now, now, req.userId, req.userId);
  broadcast(req.params.sessionId, { type: 'log.upsert', sessionId: req.params.sessionId, log: { sync_id, controller, callsign, time, rst_sent, rst_rcvd, qth, device, power, antenna, height, created_at: now, updated_at: now } });
  res.status(201).json({ sync_id });
});

// PUT /api/sessions/:sessionId/logs/:syncId
logsRouter.put('/:sessionId/logs/:syncId', (req: AuthRequest, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(req.params.sessionId) as any;
  if (!session || session.owner_user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM logs WHERE sync_id = ? AND session_id = ? AND deleted_at IS NULL').get(req.params.syncId, req.params.sessionId) as any;
  if (!existing) return res.status(404).json({ error: 'Log not found' });
  if (!req.userId || existing.created_by !== req.userId) {
    return res.status(403).json({ error: 'Only the Log author may modify it' });
  }
  const fields = ['controller', 'callsign', 'time', 'rst_sent', 'rst_rcvd', 'qth', 'device', 'power', 'antenna', 'height'];
  const updates = fields.map(f => `${f} = COALESCE(?, ${f})`).join(', ');
  db.prepare(`UPDATE logs SET ${updates}, updated_at = ?, updated_by = ? WHERE sync_id = ? AND session_id = ?`).run(...fields.map(f => req.body[f] ?? null), now, req.userId, req.params.syncId, req.params.sessionId);
  const updatedLog = db.prepare('SELECT * FROM logs WHERE sync_id = ? AND session_id = ?').get(req.params.syncId, req.params.sessionId) as any;
  broadcast(req.params.sessionId, { type: 'log.upsert', sessionId: req.params.sessionId, log: updatedLog });
  res.json({ ok: true });
});

// DELETE /api/sessions/:sessionId/logs/:syncId
logsRouter.delete('/:sessionId/logs/:syncId', (req: AuthRequest, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(req.params.sessionId) as any;
  if (!session || session.owner_user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
  const existing = db.prepare(
    'SELECT created_by FROM logs WHERE sync_id = ? AND session_id = ? AND deleted_at IS NULL',
  ).get(req.params.syncId, req.params.sessionId) as { created_by: string | null } | undefined;
  if (!existing) return res.status(404).json({ error: 'Log not found' });
  if (!req.userId || existing.created_by !== req.userId) {
    return res.status(403).json({ error: 'Only the Log author may modify it' });
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE logs SET deleted_at = ?, updated_at = ?, updated_by = ?, deleted_by = ? WHERE sync_id = ? AND session_id = ?').run(now, now, req.userId, req.userId, req.params.syncId, req.params.sessionId);
  broadcast(req.params.sessionId, { type: 'log.delete', sessionId: req.params.sessionId, syncId: req.params.syncId });
  res.json({ ok: true });
});
