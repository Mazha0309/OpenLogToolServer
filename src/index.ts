import { createServer, Server } from 'http';
import { createApp } from './app';
import { config, validateRuntimeConfig } from './config';
import { getDb } from './db/database';
import { createCollaborationWsServer } from './ws';

export function startServer(): Server {
  validateRuntimeConfig(config);
  const db = getDb();
  const users = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  validateRuntimeConfig(config, {
    requireBootstrapSecret: Number(users.count) === 0,
    requireInviteHmacKey: true,
  });

  const server = createServer(createApp({ db, config }));
  const collaborationWs = createCollaborationWsServer(server, { db, config });
  server.listen(config.port, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    console.log(`OpenLogTool Server listening on port ${port}`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
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
