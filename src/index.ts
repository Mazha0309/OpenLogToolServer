import { createServer, Server } from 'http';
import { createApp } from './app';
import { config, validateRuntimeConfig } from './config';
import { applyStoredConfigOverrides, rememberBaseConfig } from './config-overrides';
import { getDb } from './db/database';
import { createCollaborationWsServer } from './ws';
import { startSessionInactivityMonitor } from './operations/session-inactivity';

export function startServer(): Server {
  validateRuntimeConfig(config);
  const db = getDb();
  const baseConfig = rememberBaseConfig(config);
  applyStoredConfigOverrides(db, config);
  validateRuntimeConfig(config);
  const users = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  validateRuntimeConfig(config, {
    requireBootstrapSecret: Number(users.count) === 0,
    requireInviteHmacKey: true,
    requirePublicShareHmacKey: true,
  });

  const app = createApp({ db, config, baseConfig });
  const runtimeConfig = (app.locals.openLogTool as { config: typeof config }).config;
  const server = createServer(app);
  const collaborationWs = createCollaborationWsServer(server, { db, config: runtimeConfig });
  const inactivityMonitor = startSessionInactivityMonitor(db, {
    onError: (sessionId, error) => {
      console.error(`Failed to auto-close inactive Session ${sessionId}:`, error);
    },
  });
  server.once('close', () => inactivityMonitor.stop());
  server.listen(runtimeConfig.port, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : runtimeConfig.port;
    console.log(`OpenLogTool Server listening on port ${port}`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    inactivityMonitor.stop();
    collaborationWs.close();
    server.close(() => db.close());
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    console.error('Failed to start OpenLogTool Server:', error);
    process.exitCode = 1;
  }
}
