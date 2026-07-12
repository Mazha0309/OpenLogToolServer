import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';

const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'legacy-admin-test-jwt-secret-8b69604e-c4e0-4aec-a5c8-8c340dcab4b7',
  jwtIssuer: 'openlogtool-legacy-admin-test',
  bootstrapSecret: 'legacy-admin-test-bootstrap-secret-52df403d-5bed-4823',
  inviteHmacKey: 'legacy-admin-test-invite-hmac-key-97f39c08-5e54-45e3-a8ac',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

describe('legacy administrator authorization', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  const userId = 'legacy-admin';
  const password = 'legacy-admin-password';

  function token(role: 'admin' | 'user' = 'admin'): string {
    return jwt.sign(
      { type: 'legacy', userId, role },
      config.jwtSecret,
      {
        algorithm: 'HS256',
        issuer: config.jwtIssuer,
        audience: 'openlogtool-legacy',
        expiresIn: 300,
      },
    );
  }

  async function getSettings(authToken: string): Promise<Response> {
    return fetch(`${baseUrl}/api/admin/settings`, {
      headers: { authorization: `Bearer ${authToken}`, 'x-request-id': randomUUID() },
      signal: AbortSignal.timeout(5_000),
    });
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-legacy-admin-'));
    db = openDatabase(join(directory, 'legacy-admin.db'));
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, 'legacyadmin', ?, 'admin', ?, ?)
    `).run(userId, bcrypt.hashSync(password, 4), now, now);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES ('backup-admin', 'backupadmin', 'unused-test-hash', 'admin', ?, ?)
    `).run(now, now);

    server = createServer(createApp({ db, config }));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('uses the injected database and JWT config for a real login-to-admin flow', async () => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
      body: JSON.stringify({ username: 'legacyadmin', password }),
      signal: AbortSignal.timeout(5_000),
    });
    const loginBody = await login.json() as { token?: string };
    assert.equal(login.status, 200, JSON.stringify(loginBody));
    assert.equal(login.headers.get('cache-control'), 'no-store');
    assert.equal(typeof loginBody.token, 'string');

    const settings = await getSettings(loginBody.token!);
    assert.equal(settings.status, 200, await settings.text());
  });

  test('rejects an old admin token after the database role is downgraded', async () => {
    const oldToken = token();
    const initial = await getSettings(oldToken);
    assert.equal(initial.status, 200, await initial.text());

    db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(userId);

    const downgraded = await getSettings(oldToken);
    const downgradedBody = await downgraded.json();
    assert.equal(downgraded.status, 403, JSON.stringify(downgradedBody));
    assert.deepEqual(downgradedBody, { error: 'Admin only' });
  });

  test('also requires the signed legacy token to claim the admin role', async () => {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
    const response = await getSettings(token('user'));
    assert.equal(response.status, 403, await response.text());
  });

  test('records an audit event when the transitional settings route changes state', async () => {
    const auditBefore = Number(
      db.prepare('SELECT COUNT(*) FROM admin_audit_events').pluck().get(),
    );
    const invalid = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token()}`,
        'content-type': 'application/json',
        'x-request-id': randomUUID(),
      },
      body: JSON.stringify({ registration_enabled: 'false', unexpected: true }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(invalid.status, 400, await invalid.text());
    assert.equal(invalid.headers.get('cache-control'), 'no-store');
    assert.equal(
      db.prepare('SELECT registration_enabled FROM server_settings WHERE id = 1').pluck().get(),
      1,
    );
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) FROM admin_audit_events').pluck().get()),
      auditBefore,
    );

    const requestId = randomUUID();
    const response = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token()}`,
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({ registration_enabled: false }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, await response.text());
    const audit = db.prepare(`
      SELECT action, actor_user_id, target_user_id, request_id, mutation_id,
             before_json, after_json, details_json
      FROM admin_audit_events
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    `).get() as Record<string, unknown>;
    assert.equal(audit.action, 'settings.registration.updated');
    assert.equal(audit.actor_user_id, userId);
    assert.equal(audit.target_user_id, null);
    assert.equal(audit.request_id, requestId);
    assert.match(String(audit.mutation_id), /^legacy\/[0-9a-f-]{36}$/);
    assert.deepEqual(JSON.parse(String(audit.before_json)), { registrationEnabled: true });
    assert.deepEqual(JSON.parse(String(audit.after_json)), { registrationEnabled: false });
    assert.deepEqual(JSON.parse(String(audit.details_json)), { source: 'legacy-admin-api' });
  });
});
