import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { getDb } from '../db/database';
import { config } from '../config';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { createMemoryRateLimiter } from '../middleware/rate-limit';

export const authRouter = Router();
const authLimiter = createMemoryRateLimiter({
  windowMs: 60_000,
  max: 10,
  message: 'Too many authentication attempts',
});

// Register
authRouter.post('/register', ...(config.rateLimitEnabled ? [authLimiter] : []), (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get() as any;
  if (count.c === 0) {
    return res.status(409).json({
      error: 'Initialize the first administrator through /api/v1/auth/bootstrap',
    });
  }
  const settings = db.prepare('SELECT registration_enabled FROM server_settings WHERE id = 1').get() as any;
  if (!settings.registration_enabled) return res.status(403).json({ error: 'Registration disabled' });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username taken' });
  const id = randomUUID();
  const hash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  const role = 'user';
  db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, username, hash, role, now, now);
  const token = jwt.sign({ userId: id, role, type: 'legacy' }, config.jwtSecret, {
    algorithm: 'HS256',
    issuer: config.jwtIssuer,
    audience: 'openlogtool-legacy',
    expiresIn: 86_400,
  });
  res.json({ token, user: { id, username, role } });
});

// Login
authRouter.post('/login', ...(config.rateLimitEnabled ? [authLimiter] : []), (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign(
    { userId: user.id, role: user.role, type: 'legacy' },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      issuer: config.jwtIssuer,
      audience: 'openlogtool-legacy',
      expiresIn: 86_400,
    },
  );
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// Me
authRouter.get('/me', authMiddleware, (req: AuthRequest, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.userId) as any;
  res.json(user);
});
