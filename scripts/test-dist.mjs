import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const databaseModuleUrl = pathToFileURL(join(projectRoot, 'dist', 'db', 'database.js')).href;
const appModuleUrl = pathToFileURL(join(projectRoot, 'dist', 'app.js')).href;
const wsModuleUrl = pathToFileURL(join(projectRoot, 'dist', 'ws', 'index.js')).href;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'openlogtool-dist-'));
const databasePath = join(temporaryDirectory, 'production.db');

let db;
let server;
let wsController;

function moduleExports(namespace) {
  const defaultExport = namespace.default;
  return {
    ...(defaultExport && typeof defaultExport === 'object' ? defaultExport : {}),
    ...namespace,
  };
}

function quoteIdentifier(value) {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/);
  return `"${value}"`;
}

function tableNames(database) {
  return new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name)),
  );
}

function columnNames(database, table) {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map((row) => String(row.name)),
  );
}

function requireColumns(database, table, expected) {
  const actual = columnNames(database, table);
  for (const column of expected) {
    assert.ok(actual.has(column), `${table}.${column} is missing; found: ${[...actual].join(', ')}`);
  }
}

function hasUniqueIndex(database, table, expectedColumns) {
  const indexes = database.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all();
  return indexes.some((index) => {
    if (Number(index.unique) !== 1) return false;
    const columns = database
      .prepare(`PRAGMA index_info(${quoteIdentifier(String(index.name))})`)
      .all()
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((row) => String(row.name));
    return (
      columns.length === expectedColumns.length &&
      columns.every((column, position) => column === expectedColumns[position])
    );
  });
}

try {
  const databaseModule = moduleExports(await import(databaseModuleUrl));
  assert.equal(
    typeof databaseModule.openDatabase,
    'function',
    'dist/db/database.js must export openDatabase(path)',
  );
  assert.equal(
    typeof databaseModule.runMigrations,
    'function',
    'dist/db/database.js must export runMigrations(db)',
  );

  db = await databaseModule.openDatabase(databasePath);
  await databaseModule.runMigrations(db);

  const tables = tableNames(db);
  for (const table of [
    'schema_migrations',
    'users',
    'server_settings',
    'sessions',
    'logs',
    'shares',
    'refresh_tokens',
    'session_members',
    'collaboration_invites',
    'invite_redemptions',
    'processed_mutations',
    'session_events',
    'ws_tickets',
    'admin_audit_events',
    'collaboration_audit_events',
    'public_shares',
    'public_ws_tickets',
  ]) {
    assert.ok(tables.has(table), `production dist migration did not create table: ${table}`);
  }

  requireColumns(db, 'schema_migrations', ['version', 'name', 'checksum', 'applied_at']);
  requireColumns(db, 'server_settings', [
    'instance_id',
    'registration_enabled',
    'invite_hmac_fingerprint',
    'public_share_hmac_fingerprint',
  ]);
  requireColumns(db, 'sessions', [
    'id',
    'status',
    'owner_user_id',
    'version',
    'event_seq',
    'created_at',
    'updated_at',
    'deleted_at',
  ]);
  requireColumns(db, 'logs', [
    'sync_id',
    'session_id',
    'rst_sent',
    'rst_rcvd',
    'remarks',
    'version',
    'created_at',
    'updated_at',
    'deleted_at',
  ]);
  requireColumns(db, 'refresh_tokens', [
    'id',
    'user_id',
    'token_hash',
    'created_at',
    'expires_at',
    'revoked_at',
  ]);
  requireColumns(db, 'session_members', [
    'id',
    'session_id',
    'user_id',
    'role',
    'version',
    'removed_at',
  ]);
  requireColumns(db, 'collaboration_invites', [
    'id',
    'session_id',
    'code_hash',
    'role',
    'max_uses',
    'used_count',
    'expires_at',
    'revoked_at',
  ]);
  requireColumns(db, 'invite_redemptions', [
    'join_request_id',
    'device_id',
    'request_hash',
    'response_json',
  ]);
  requireColumns(db, 'session_events', [
    'id',
    'session_id',
    'seq',
    'type',
    'entity_type',
    'entity_id',
    'entity_version',
    'mutation_id',
    'payload_json',
  ]);
  requireColumns(db, 'ws_tickets', [
    'id',
    'token_hash',
    'session_id',
    'user_id',
    'device_id',
    'after_seq',
    'expires_at',
    'consumed_at',
  ]);
  requireColumns(db, 'admin_audit_events', [
    'id',
    'action',
    'actor_user_id',
    'target_user_id',
    'request_id',
    'mutation_id',
    'before_json',
    'after_json',
    'details_json',
    'occurred_at',
  ]);
  requireColumns(db, 'collaboration_audit_events', [
    'id',
    'session_id',
    'action',
    'actor_user_id',
    'target_user_id',
    'request_id',
    'mutation_id',
    'before_json',
    'after_json',
    'details_json',
    'occurred_at',
  ]);
  requireColumns(db, 'public_shares', [
    'id',
    'session_id',
    'credential_version',
    'secret_hash',
    'created_by',
    'created_at',
    'expires_at',
    'revoked_at',
    'revoked_by',
  ]);
  requireColumns(db, 'public_ws_tickets', [
    'id',
    'token_hash',
    'public_share_id',
    'access_token_id',
    'after_seq',
    'issued_ip',
    'created_at',
    'expires_at',
    'authorization_expires_at',
    'consumed_at',
  ]);

  assert.ok(
    hasUniqueIndex(db, 'logs', ['session_id', 'sync_id']),
    'production schema requires UNIQUE(session_id, sync_id)',
  );
  assert.ok(
    Number(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count) > 0,
    'production migrations must record at least one applied migration',
  );
  assert.equal(
    Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version),
    11,
    'production dist must include the public Liveshare capability migration',
  );
  assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1);
  assert.equal(String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');

  const appModule = moduleExports(await import(appModuleUrl));
  assert.equal(typeof appModule.createApp, 'function', 'dist/app.js must export createApp(options)');
  const runtimeConfig = {
    port: 0,
    dbPath: databasePath,
    jwtSecret: 'dist-smoke-jwt-secret-that-is-at-least-32-bytes',
    jwtIssuer: 'openlogtool-dist-smoke',
    bootstrapSecret: 'dist-smoke-bootstrap-secret',
    inviteHmacKey: 'dist-smoke-invite-hmac-key-at-least-32-bytes',
    publicShareHmacKey: 'dist-smoke-public-share-hmac-key-at-least-32-bytes',
    accessTokenTtlSeconds: 300,
    refreshTokenTtlSeconds: 3_600,
    corsOrigins: [],
    trustProxy: false,
    jsonBodyLimit: '1mb',
    rateLimitEnabled: false,
    environment: 'test',
  };
  const app = appModule.createApp({ db, config: runtimeConfig });
  server = createServer(app);
  const wsModule = moduleExports(await import(wsModuleUrl));
  assert.equal(
    typeof wsModule.createCollaborationWsServer,
    'function',
    'dist/ws/index.js must export createCollaborationWsServer(server, options)',
  );
  wsController = wsModule.createCollaborationWsServer(server, { db, config: runtimeConfig });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/server-info`);
  assert.equal(response.status, 200);
  const info = await response.json();
  assert.equal(info.serverInstanceId, db.prepare('SELECT instance_id FROM server_settings WHERE id = 1').get().instance_id);
  for (const feature of [
    'collaboration',
    'collaborationSecurityAudit',
    'sessionMutations',
    'sessionEvents',
    'collaborationWebSocket',
    'publicLiveshare',
  ]) {
    assert.ok(info.features.includes(feature), `server-info is missing ${feature}`);
  }

  console.log('dist database and HTTP smoke test passed');
} finally {
  wsController?.close();
  if (server?.listening) {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
  db?.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
