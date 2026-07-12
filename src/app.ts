import Database from 'better-sqlite3';
import compression from 'compression';
import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import path from 'path';
import { createAdminRouter } from './api/admin';
import { createAdminV1Router } from './api/admin-v1';
import { createAuthRouter } from './api/auth';
import { createAuthV1Router } from './api/auth-v1';
import { createCollaborationInvitesV1Router } from './api/collaboration-invites-v1';
import { createCollaborationSyncV1Router } from './api/collaboration-sync-v1';
import { createServerInfoRouter } from './api/server-info';
import { createSessionMembershipV1Router } from './api/session-members-v1';
import { createSessionsV1Router } from './api/sessions-v1';
import {
  createPublicSessionsV1Router,
  createPublicShareExchangeV1Router,
  createSessionPublicSharesV1Router,
} from './api/public-shares-v1';
import { AppConfig, config as defaultConfig } from './config';
import { getDb } from './db/database';
import { getRealtimeHub } from './collaboration/realtime';
import { errorMiddleware, notFoundMiddleware } from './middleware/error-handler';
import { requestIdMiddleware } from './middleware/request-id';

export interface CreateAppOptions {
  db?: Database.Database;
  config?: Partial<AppConfig>;
}

function resolveConfig(overrides?: Partial<AppConfig>): AppConfig {
  return { ...defaultConfig, ...overrides };
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const runtimeConfig = resolveConfig(options.config);
  const db = options.db ?? getDb();

  app.disable('x-powered-by');
  app.set('trust proxy', runtimeConfig.trustProxy);
  app.locals.openLogTool = { db, config: runtimeConfig, realtime: getRealtimeHub(db) };

  app.use(requestIdMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || runtimeConfig.corsOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: false,
    }),
  );
  app.use(compression());
  app.use(
    [
      '/api/v1/admin',
      '/api/admin',
      '/api/v1/auth',
      '/api/auth',
      '/api/v1/sessions',
      '/api/v1/collaboration-invites',
      '/api/v1/public-shares',
      '/api/v1/public',
    ],
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );
  app.use(express.json({ limit: runtimeConfig.jsonBodyLimit }));

  app.use(
    '/api/v1/server-info',
    createServerInfoRouter({ db, config: runtimeConfig }),
  );
  app.use('/api/v1/auth', createAuthV1Router({ db, config: runtimeConfig }));
  app.use('/api/v1/admin', createAdminV1Router({ db, config: runtimeConfig }));
  app.use('/api/v1/sessions', createSessionsV1Router({ db, config: runtimeConfig }));
  app.use(
    '/api/v1/sessions',
    createCollaborationSyncV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/sessions',
    createSessionMembershipV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/sessions',
    createSessionPublicSharesV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/collaboration-invites',
    createCollaborationInvitesV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/public-shares',
    createPublicShareExchangeV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/public/sessions',
    createPublicSessionsV1Router({ db, config: runtimeConfig }),
  );

  // Keep only the legacy account/admin surface needed by the bundled admin UI.
  // The v0 Session, Log, Share and Liveshare routes are intentionally not mounted:
  // they bypass v1 object authorization, idempotency and replica sequencing.
  app.use('/api/auth', createAuthRouter({ db, config: runtimeConfig }));
  app.use('/api/admin', createAdminRouter({ db, config: runtimeConfig }));

  app.use('/admin', express.static(path.join(__dirname, '../web/dist')));
  app.get('/admin/*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../web/dist/index.html'));
  });

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);
  return app;
}
