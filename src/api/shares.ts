import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { getDb } from '../db/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const sharesRouter = Router();
sharesRouter.use(authMiddleware);

// Generate an 8-char random code
function generateCode(): string {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

// POST /api/shares/generate — 为当前 session 生成分享码
sharesRouter.post('/generate', (req: AuthRequest, res) => {
  const { sessionId, expiresInHours } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(sessionId) as any;
  if (!session || session.owner_user_id !== req.userId) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const id = uuid();
  const code = generateCode();
  const now = new Date().toISOString();
  let expiresAt: string | null = null;
  if (expiresInHours && expiresInHours > 0) {
    expiresAt = new Date(Date.now() + expiresInHours * 3600000).toISOString();
  }

  db.prepare('INSERT INTO shares (id, session_id, code, owner_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, sessionId, code, req.userId, now, expiresAt);
  res.status(201).json({ id, code, session_id: sessionId, expires_at: expiresAt });
});

// POST /api/shares/join — 通过分享码加入
sharesRouter.post('/join', (req: AuthRequest, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const db = getDb();
  const share = db.prepare('SELECT * FROM shares WHERE code = ? AND revoked_at IS NULL').get(code) as any;
  if (!share) return res.status(404).json({ error: 'Invalid or revoked share code' });

  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Share code expired' });
  }

  // 一次性使用：立即撤销
  db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), share.id);

  // 返回 session 数据
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(share.session_id) as any;
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const logs = db.prepare('SELECT * FROM logs WHERE session_id = ? AND deleted_at IS NULL ORDER BY time ASC').all(share.session_id);
  res.json({ ...session, logs });
});

// GET /api/shares — 我创建的分享码列表
sharesRouter.get('/', (req: AuthRequest, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.*, sess.title as session_title
    FROM shares s JOIN sessions sess ON s.session_id = sess.id
    WHERE s.owner_user_id = ? AND s.revoked_at IS NULL
    ORDER BY s.created_at DESC
  `).all(req.userId);
  res.json(rows);
});

// DELETE /api/shares/:id — 撤销分享码
sharesRouter.delete('/:id', (req: AuthRequest, res) => {
  const db = getDb();
  const share = db.prepare('SELECT * FROM shares WHERE id = ?').get(req.params.id) as any;
  if (!share || share.owner_user_id !== req.userId) {
    return res.status(404).json({ error: 'Not found' });
  }
  db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), share.id);
  res.json({ ok: true });
});

// GET /api/sessions/:sessionId/shares — 查看某个 session 的分享码
sharesRouter.get('/session/:sessionId', (req: AuthRequest, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(req.params.sessionId) as any;
  if (!session || session.owner_user_id !== req.userId) {
    return res.status(404).json({ error: 'Not found' });
  }
  const shares = db.prepare('SELECT * FROM shares WHERE session_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(req.params.sessionId);
  res.json(shares);
});
