# OpenLogTool 服务端重构实施计划

> **归档计划（2026-07-09）**：本文仅用于保留早期实施过程，不是当前 API、
> 依赖版本或部署说明。当前行为以仓库根目录 `README.md`、
> `docs/*-api-v1.md` 和 `../specs/2026-07-11-collaboration-v1-design.md` 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 OpenLogToolServer 完全重写为 TypeScript + Express + SQLite，提供用户认证、session/日志 CRUD、liveshare Web 实时展示。

**Architecture:** Express 后端 + better-sqlite3 + JWT 认证 + ws WebSocket；React + Vite 前端管理后台；Liveshare 为独立的 Web 页面。

**Tech Stack:** TypeScript, Node.js, Express, better-sqlite3, jsonwebtoken, bcryptjs, ws, React 18, Vite, Ant Design

---

## Task 1: TypeScript 后端骨架

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env`, `.env.example`, `.gitignore`
- Create: `src/index.ts`, `src/config.ts`, `src/db/database.ts`, `src/db/schema.sql`

**Details:**

- [ ] **Step 1: 初始化项目**

```bash
mkdir -p src/db src/api src/middleware src/ws
```

Create `package.json`:
```json
{
  "name": "openlogtool-server",
  "version": "0.5.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc"
  },
  "dependencies": {
    "express": "^4.21.0",
    "better-sqlite3": "^12.10.0",
    "jsonwebtoken": "^9.0.2",
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "helmet": "^7.1.0",
    "uuid": "^10.0.0",
    "ws": "^8.20.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/better-sqlite3": "^7.6.8",
    "@types/jsonwebtoken": "^9.0.5",
    "@types/bcryptjs": "^2.4.6",
    "@types/cors": "^2.8.17",
    "@types/uuid": "^10.0.0",
    "@types/ws": "^8.5.10",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}
```

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

Create `.env`:
```
PORT=3000
JWT_SECRET=change-me-to-a-random-string
```

- [ ] **Step 2: 数据库初始化 + 迁移**

`src/db/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registration_enabled INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO server_settings (id, registration_enabled) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  controller TEXT NOT NULL,
  callsign TEXT NOT NULL,
  time TEXT NOT NULL,
  rst_sent TEXT,
  rst_rcvd TEXT,
  qth TEXT,
  device TEXT,
  power TEXT,
  antenna TEXT,
  height TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id);
CREATE INDEX IF NOT EXISTS idx_logs_sync_id ON logs(sync_id);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_user_id);
```

`src/db/database.ts`:
```typescript
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './data/openlogtool.db';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}
```

- [ ] **Step 3: Config + Auth middleware**

`src/config.ts`:
```typescript
import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000'),
  jwtSecret: process.env.JWT_SECRET || 'default-secret-change-me',
};
```

`src/middleware/auth.ts`:
```typescript
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret) as any;
    req.userId = payload.userId;
    req.userRole = payload.role;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}
```

`src/middleware/admin.ts`:
```typescript
import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';

export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}
```

- [ ] **Step 4: Express entry point**

`src/index.ts`:
```typescript
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { config } from './config';
import { getDb } from './db/database';
import { authRouter } from './api/auth';
import { sessionsRouter } from './api/sessions';
import { logsRouter } from './api/logs';
import { adminRouter } from './api/admin';
import { createWsServer } from './ws';

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// API
app.use('/api/auth', authRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/sessions', logsRouter);
app.use('/api/admin', adminRouter);

// Liveshare web page
app.use('/live', express.static(path.join(__dirname, '../live/dist')));
app.get('/live/*', (_, res) => {
  res.sendFile(path.join(__dirname, '../live/dist/index.html'));
});

// Admin web UI
app.use('/admin', express.static(path.join(__dirname, '../web/dist')));
app.get('/admin/*', (_, res) => {
  res.sendFile(path.join(__dirname, '../web/dist/index.html'));
});

const server = app.listen(config.port, () => {
  getDb();
  console.log(`Server running on port ${config.port}`);
});

createWsServer(server);
```

- [ ] **Step 5: 安装依赖并测试启动**

```bash
npm install
npx tsc --noEmit  # 类型检查
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: TypeScript backend skeleton with SQLite + auth"
```

---

## Task 2: Auth API + Sessions CRUD

**Files:**
- Create: `src/api/auth.ts`
- Create: `src/api/sessions.ts`

**Details:**

- [ ] **Step 1: Auth API**

`src/api/auth.ts`:
```typescript
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database';
import { config } from '../config';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const authRouter = Router();

// Register
authRouter.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const db = getDb();
  const settings = db.prepare('SELECT registration_enabled FROM server_settings WHERE id = 1').get() as any;
  if (!settings.registration_enabled) return res.status(403).json({ error: 'Registration disabled' });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username taken' });
  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get() as any;
  const role = count.c === 0 ? 'admin' : 'user';
  db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, username, hash, role, now, now);
  const token = jwt.sign({ userId: id, role }, config.jwtSecret);
  res.json({ token, user: { id, username, role } });
});

// Login
authRouter.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ userId: user.id, role: user.role }, config.jwtSecret);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// Me
authRouter.get('/me', authMiddleware, (req: AuthRequest, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.userId) as any;
  res.json(user);
});
```

- [ ] **Step 2: Sessions CRUD**

`src/api/sessions.ts`:
```typescript
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
```

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/api/auth.ts src/api/sessions.ts
git commit -m "feat: auth API + sessions CRUD"
```

---

## Task 3: Logs CRUD + Broadcast

**Files:**
- Create: `src/api/logs.ts`
- Create: `src/ws/index.ts`

**Details:**

- [ ] **Step 1: Logs API**

`src/api/logs.ts`:
```typescript
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
  db.prepare(`INSERT INTO logs (sync_id, session_id, controller, callsign, time, rst_sent, rst_rcvd, qth, device, power, antenna, height, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sync_id, req.params.sessionId, controller, callsign, time, rst_sent ?? null, rst_rcvd ?? null, qth ?? null, device ?? null, power ?? null, antenna ?? null, height ?? null, now, now);
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
  const fields = ['controller', 'callsign', 'time', 'rst_sent', 'rst_rcvd', 'qth', 'device', 'power', 'antenna', 'height'];
  const updates = fields.map(f => `${f} = COALESCE(?, ${f})`).join(', ');
  db.prepare(`UPDATE logs SET ${updates}, updated_at = ? WHERE sync_id = ? AND session_id = ?`).run(...fields.map(f => req.body[f] ?? null), now, req.params.syncId, req.params.sessionId);
  broadcast(req.params.sessionId, { type: 'log.upsert', sessionId: req.params.sessionId, log: { ...existing, ...req.body, updated_at: now } });
  res.json({ ok: true });
});

// DELETE /api/sessions/:sessionId/logs/:syncId
logsRouter.delete('/:sessionId/logs/:syncId', (req: AuthRequest, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(req.params.sessionId) as any;
  if (!session || session.owner_user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
  const now = new Date().toISOString();
  db.prepare('UPDATE logs SET deleted_at = ?, updated_at = ? WHERE sync_id = ? AND session_id = ?').run(now, now, req.params.syncId, req.params.sessionId);
  broadcast(req.params.sessionId, { type: 'log.delete', sessionId: req.params.sessionId, syncId: req.params.syncId });
  res.json({ ok: true });
});
```

- [ ] **Step 2: WebSocket server**

`src/ws/index.ts`:
```typescript
import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const rooms = new Map<string, Set<WebSocket>>();

export function createWsServer(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) { ws.close(4000, 'Missing sessionId'); return; }
    if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
    rooms.get(sessionId)!.add(ws);
    ws.on('close', () => {
      rooms.get(sessionId)?.delete(ws);
      if (rooms.get(sessionId)?.size === 0) rooms.delete(sessionId);
    });
  });
}

export function broadcast(sessionId: string, message: object) {
  const clients = rooms.get(sessionId);
  if (!clients) return;
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
```

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/api/logs.ts src/ws/index.ts
git commit -m "feat: logs CRUD + WebSocket broadcast"
```

---

## Task 4: Admin API

**Files:**
- Create: `src/api/admin.ts`

**Details:**

- [ ] **Step 1: Admin API**

`src/api/admin.ts`:
```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/api/admin.ts
git commit -m "feat: admin API (settings + users)"
```

---

## Task 5: React Admin WebUI

**Files:**
- Initialize: `web/` directory with `npm create vite@latest web -- --template react-ts`
- Modify: `web/src/App.tsx`, `web/src/pages/Login.tsx`, `web/src/pages/Dashboard.tsx`, `web/src/pages/Admin.tsx`
- Modify: `web/vite.config.ts` (set base path `/admin/`)

- [ ] **Step 1: Initialize Vite + React project**

```bash
cd web && npm create vite@latest . -- --template react-ts && npm install antd @ant-design/icons axios dayjs react-router-dom
```

Configure `web/vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
```

- [ ] **Step 2: Implement auth context + API client**

`web/src/api.ts`:
```typescript
import axios from 'axios';

const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default api;
```

`web/src/AuthContext.tsx`:
```tsx
import { createContext, useContext, useState, ReactNode } from 'react';
import api from './api';

interface User { id: string; username: string; role: string; }
interface AuthCtx { user: User | null; token: string | null; login: (u: string, p: string) => Promise<void>; logout: () => void; }

const AuthContext = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const s = localStorage.getItem('user');
    return s ? JSON.parse(s) : null;
  });
  const [token] = useState(localStorage.getItem('token'));

  const login = async (username: string, password: string) => {
    const { data } = await api.post('/auth/login', { username, password });
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

  return <AuthContext.Provider value={{ user, token, login, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
```

- [ ] **Step 3: Login page**

`web/src/pages/Login.tsx`:
```tsx
import { Form, Input, Button, Card, message } from 'antd';
import { useAuth } from '../AuthContext';
import { useNavigate } from 'react-router-dom';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const onFinish = async (values: { username: string; password: string }) => {
    try {
      await login(values.username, values.password);
      navigate('/');
    } catch { message.error('登录失败'); }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <Card title="OpenLogTool 管理" style={{ width: 360 }}>
        <Form onFinish={onFinish}>
          <Form.Item name="username" rules={[{ required: true }]}>
            <Input placeholder="用户名" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true }]}>
            <Input.Password placeholder="密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>登录</Button>
        </Form>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Dashboard (sessions list)**

`web/src/pages/Dashboard.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { Table, Card, Typography } from 'antd';
import api from '../api';

interface Session { id: string; title: string; status: string; created_at: string; }

export default function Dashboard() {
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => { api.get('/sessions').then(r => setSessions(r.data)); }, []);

  return (
    <Card title={<Typography.Title level={4}>Session 列表</Typography.Title>}>
      <Table dataSource={sessions} rowKey="id" columns={[
        { title: '标题', dataIndex: 'title' },
        { title: '状态', dataIndex: 'status' },
        { title: '创建时间', dataIndex: 'created_at' },
      ]} />
    </Card>
  );
}
```

- [ ] **Step 5: Admin page**

`web/src/pages/Admin.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { Card, Switch, Table, message, Typography } from 'antd';
import api from '../api';

interface User { id: string; username: string; role: string; created_at: string; }

export default function Admin() {
  const [regEnabled, setRegEnabled] = useState(true);
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    api.get('/admin/settings').then(r => setRegEnabled(!!r.data.registration_enabled));
    api.get('/admin/users').then(r => setUsers(r.data));
  }, []);

  const toggleReg = async (v: boolean) => {
    await api.put('/admin/settings', { registration_enabled: v });
    setRegEnabled(v);
    message.success(v ? '已开启注册' : '已关闭注册');
  };

  return (
    <>
      <Card title={<Typography.Title level={4}>服务器设置</Typography.Title>}>
        <div style={{ marginBottom: 16 }}>
          <span>允许注册：</span>
          <Switch checked={regEnabled} onChange={toggleReg} />
        </div>
      </Card>
      <Card title={<Typography.Title level={4}>用户管理</Typography.Title>} style={{ marginTop: 16 }}>
        <Table dataSource={users} rowKey="id" columns={[
          { title: '用户名', dataIndex: 'username' },
          { title: '角色', dataIndex: 'role' },
          { title: '创建时间', dataIndex: 'created_at' },
        ]} />
      </Card>
    </>
  );
}
```

- [ ] **Step 6: App router + main**

Update `web/src/App.tsx`:
```tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, Layout, Menu, Button } from 'antd';
import { AuthProvider, useAuth } from './AuthContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Admin from './pages/Admin';
import { useNavigate } from 'react-router-dom';

function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return <Navigate to="/login" />;

  const menuItems = [
    { key: '/', label: 'Sessions' },
    ...(user.role === 'admin' ? [{ key: '/admin', label: '管理' }] : []),
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Menu theme="dark" mode="horizontal" items={menuItems} onClick={({ key }) => navigate(key)} style={{ flex: 1 }} />
        <Button onClick={() => { logout(); navigate('/login'); }} type="text" style={{ color: '#fff' }}>{user.username} - 退出</Button>
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </Layout.Content>
    </Layout>
  );
}

export default function App() {
  return (
    <ConfigProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/*" element={<AppLayout />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ConfigProvider>
  );
}
```

- [ ] **Step 7: Build & verify**

```bash
cd web && npm run build
```

Verify the built files appear in `web/dist/index.html`.

- [ ] **Step 8: Commit**

```bash
git add web/
git commit -m "feat(web): React admin UI (login, dashboard, admin)"
```

---

## Task 6: Liveshare Web 页面

**Files:**
- Create: `live/` Vite project with React
- Modify: `live/src/pages/Live.tsx`

- [ ] **Step 1: Initialize Vite project for liveshare**

```bash
mkdir -p live && cd live && npm create vite@latest . -- --template react-ts && npm install antd dayjs
```

Configure `live/vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/live/',
  server: { proxy: { '/ws': { target: 'ws://localhost:3000', ws: true } } },
});
```

- [ ] **Step 2: Liveshare page**

`live/src/App.tsx`:
```tsx
import { useEffect, useState, useRef } from 'react';
import { Table, Typography, Tag } from 'antd';
import dayjs from 'dayjs';

interface LogEntry {
  sync_id: string; controller: string; callsign: string; time: string;
  rst_sent?: string; rst_rcvd?: string; qth?: string; device?: string;
  power?: string; antenna?: string; height?: string;
  updated_at?: string;
}

const WS_BASE = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

export default function Live() {
  const sessionId = window.location.pathname.replace('/live/', '');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const ws = new WebSocket(`${WS_BASE}/ws?sessionId=${sessionId}`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'log.upsert') {
        setLogs(prev => {
          const idx = prev.findIndex(l => l.sync_id === msg.log.sync_id);
          if (idx >= 0) { const next = [...prev]; next[idx] = msg.log; return next; }
          return [...prev, msg.log];
        });
      } else if (msg.type === 'log.delete') {
        setLogs(prev => prev.filter(l => l.sync_id !== msg.syncId));
      }
    };
    wsRef.current = ws;
    return () => ws.close();
  }, [sessionId]);

  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        Session: {sessionId} <Tag color="green">LIVE</Tag>
      </Typography.Title>
      <Table dataSource={logs} rowKey="sync_id" columns={[
        { title: '时间', dataIndex: 'time', width: 80, render: (v: string) => v?.substring(0, 5) },
        { title: '主控', dataIndex: 'controller', width: 90 },
        { title: '呼号', dataIndex: 'callsign', width: 90 },
        { title: 'RST发', dataIndex: 'rst_sent', width: 70 },
        { title: 'RST收', dataIndex: 'rst_rcvd', width: 70 },
        { title: '设备', dataIndex: 'device', width: 90 },
        { title: '天线', dataIndex: 'antenna', width: 90 },
        { title: '功率', dataIndex: 'power', width: 60 },
        { title: 'QTH', dataIndex: 'qth', width: 100 },
        { title: '高度', dataIndex: 'height', width: 60 },
      ]} pagination={false} size="small" bordered />
    </div>
  );
}
```

- [ ] **Step 3: Build**

```bash
cd live && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add live/
git commit -m "feat(live): liveshare real-time web page"
```

---

## Task 7: 最终整合验证

**Files:**
- Verify all builds work together

- [ ] **Step 1: TypeScript 编译**

```bash
cd server-project && npx tsc --noEmit
```

- [ ] **Step 2: 构建前端 + liveshare**

```bash
cd web && npm run build
cd ../live && npm run build
```

- [ ] **Step 3: 启动 server**

```bash
cd .. && npm run dev
```

访问 `http://localhost:3000/admin` 应显示登录页面。注册两个用户，创建 session，用 curl 提交日志，访问 `http://localhost:3000/live/<sessionId>` 确认实时更新。

- [ ] **Step 4: Commit（如果有修复）**

```bash
git commit -am "fix: 整合验证修复"
```
