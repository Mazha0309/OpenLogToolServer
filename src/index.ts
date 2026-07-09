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
