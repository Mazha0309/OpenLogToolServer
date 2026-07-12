import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';

type JsonObject = Record<string, unknown>;

interface HttpResult {
  status: number;
  headers: Headers;
  body: JsonObject;
  text: string;
}

interface SeedUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  createdAt: string;
}

const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'admin-v1-test-jwt-secret-68343815-96e8-4743-9410-e201cb822719',
  jwtIssuer: 'openlogtool-admin-v1-test',
  bootstrapSecret: 'admin-v1-bootstrap-secret-b118db22-b0e8-4a47-9eaa',
  inviteHmacKey: 'admin-v1-invite-hmac-key-f7ccde53-f4d4-4b31-bfaa-e7d56e840960',
  publicShareHmacKey: 'admin-v1-public-share-key-41d3746f-e17c-4aa8-90bd',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

const users: SeedUser[] = [
  {
    id: 'stable-a',
    username: 'samea',
    role: 'user',
    createdAt: '2026-06-01T00:00:00.000Z',
  },
  {
    id: 'stable-b',
    username: 'sameb',
    role: 'user',
    createdAt: '2026-06-01T00:00:00.000Z',
  },
  {
    id: 'admin-root',
    username: 'rootadmin',
    role: 'admin',
    createdAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'alpha-user',
    username: 'alphauser',
    role: 'user',
    createdAt: '2026-04-01T00:00:00.000Z',
  },
  {
    id: 'alpha-admin',
    username: 'alphaadmin',
    role: 'admin',
    createdAt: '2026-03-01T00:00:00.000Z',
  },
  {
    id: 'former-admin',
    username: 'formeradmin',
    role: 'user',
    createdAt: '2026-02-01T00:00:00.000Z',
  },
  {
    id: 'session-owner',
    username: 'sessionowner',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'literal-percent',
    username: 'literal%mark',
    role: 'user',
    createdAt: '2025-03-01T00:00:00.000Z',
  },
  {
    id: 'literal-underscore',
    username: 'literal_mark',
    role: 'user',
    createdAt: '2025-02-01T00:00:00.000Z',
  },
  {
    id: 'literal-backslash',
    username: 'literal\\mark',
    role: 'user',
    createdAt: '2025-01-01T00:00:00.000Z',
  },
];

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function assertError(result: HttpResult, status: number, code: string): void {
  assert.equal(result.status, status, result.text);
  assertObject(result.body.error, 'error');
  assert.equal(result.body.error.code, code, result.text);
}

function assertNoStore(result: HttpResult): void {
  assert.equal(result.headers.get('cache-control'), 'no-store');
}

function exactKeys(value: JsonObject, expected: string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

describe('v1 server administration API', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let instanceId: string;
  const fingerprint = 'admin-v1-fingerprint-must-not-change';

  function accessToken(userId: string, role: 'admin' | 'user'): string {
    return jwt.sign(
      { type: 'access', role },
      config.jwtSecret,
      {
        algorithm: 'HS256',
        subject: userId,
        jwtid: randomUUID(),
        issuer: config.jwtIssuer,
        audience: 'openlogtool-v1',
        expiresIn: 300,
      },
    );
  }

  function legacyToken(userId: string): string {
    return jwt.sign(
      { type: 'legacy', userId, role: 'admin' },
      config.jwtSecret,
      {
        algorithm: 'HS256',
        issuer: config.jwtIssuer,
        audience: 'openlogtool-legacy',
        expiresIn: 300,
      },
    );
  }

  async function request(
    path: string,
    options: {
      method?: string;
      token?: string;
      body?: unknown;
      rawBody?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': randomUUID(),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.rawBody ?? (
        options.body === undefined ? undefined : JSON.stringify(options.body)
      ),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    assertObject(parsed, 'HTTP response');
    return { status: response.status, headers: response.headers, body: parsed, text };
  }

  function totalChanges(): number {
    const row = db.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    return Number(row.changes);
  }

  function idempotencyHeaders(label: string): Record<string, string> {
    return { 'idempotency-key': `${label}-${randomUUID()}` };
  }

  function insertRefreshToken(
    userId: string,
    options: { expiresAt?: string; revokedAt?: string | null } = {},
  ): string {
    const id = randomUUID();
    const now = new Date();
    db.prepare(`
      INSERT INTO refresh_tokens (
        id, user_id, token_hash, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      `TEST_TOKEN_HASH_${id}`,
      now.toISOString(),
      options.expiresAt ?? new Date(now.getTime() + 3_600_000).toISOString(),
      options.revokedAt ?? null,
    );
    return id;
  }

  function auditCount(where = '', parameters: unknown[] = []): number {
    const row = db.prepare(`
      SELECT COUNT(*) AS total
      FROM admin_audit_events
      ${where}
    `).get(...parameters) as { total: number };
    return Number(row.total);
  }

  function settingsRow(): {
    registration_enabled: number;
    instance_id: string;
    invite_hmac_fingerprint: string;
  } {
    return db.prepare(`
      SELECT registration_enabled, instance_id, invite_hmac_fingerprint
      FROM server_settings WHERE id = 1
    `).get() as {
      registration_enabled: number;
      instance_id: string;
      invite_hmac_fingerprint: string;
    };
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-admin-v1-'));
    const databasePath = join(directory, 'admin-v1.db');
    db = openDatabase(databasePath);
    config.dbPath = databasePath;

    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const user of users) {
      insertUser.run(
        user.id,
        user.username,
        `NEVER_EXPOSE_PASSWORD_HASH_${user.id}`,
        user.role,
        user.createdAt,
        user.createdAt,
      );
    }

    const now = '2026-07-01T00:00:00.000Z';
    const insertSession = db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, 'session-owner', 1, 0, 0, ?, ?, ?)
    `);
    insertSession.run('session-initializing', 'Sensitive initializing title', 'initializing', now, now, null);
    insertSession.run('session-active', 'Sensitive active title', 'active', now, now, null);
    insertSession.run('session-closed', 'Sensitive closed title', 'closed', now, now, null);
    insertSession.run('session-deleted', 'Sensitive deleted title', 'active', now, now, now);

    const insertMember = db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES (?, ?, 'session-owner', 'owner', 1, ?, ?)
    `);
    for (const sessionId of [
      'session-initializing',
      'session-active',
      'session-closed',
      'session-deleted',
    ]) {
      insertMember.run(randomUUID(), sessionId, now, now);
    }

    db.prepare(`
      INSERT INTO logs (
        sync_id, session_id, controller, callsign, time, rst_sent, rst_rcvd,
        qth, device, power, antenna, height, remarks, created_at, updated_at
      ) VALUES (
        'sensitive-sync-id', 'session-active', 'SECRET-CONTROLLER',
        'SECRET-CALLSIGN', '12:34', '59', '59', 'SECRET-QTH', 'SECRET-DEVICE',
        '100W', 'SECRET-ANTENNA', '10M', 'SECRET-REMARKS', ?, ?
      )
    `).run(now, now);

    db.prepare(`
      UPDATE server_settings SET invite_hmac_fingerprint = ? WHERE id = 1
    `).run(fingerprint);
    const identity = settingsRow();
    instanceId = identity.instance_id;

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

  test('requires a current v1 administrator and returns no-store on every auth outcome', async () => {
    const cases: Array<[string, string | undefined, number, string]> = [
      ['missing token', undefined, 401, 'AUTH_REQUIRED'],
      ['legacy token', legacyToken('admin-root'), 401, 'TOKEN_INVALID'],
      ['ordinary user', accessToken('alpha-user', 'user'), 403, 'ADMIN_REQUIRED'],
      [
        'stale token claiming a demoted administrator',
        accessToken('former-admin', 'admin'),
        403,
        'ADMIN_REQUIRED',
      ],
      ['token whose user was deleted', accessToken('missing-user', 'admin'), 401, 'TOKEN_INVALID'],
    ];

    for (const [label, token, status, code] of cases) {
      const result = await request('/api/v1/admin/overview', { token });
      assertError(result, status, code);
      assertNoStore(result);
      assert.ok(label);
    }

    const success = await request('/api/v1/admin/overview', {
      token: accessToken('admin-root', 'admin'),
    });
    assert.equal(success.status, 200, success.text);
    assertNoStore(success);
  });

  test('a demoted administrator cannot replay a previously successful mutation', async () => {
    const token = accessToken('alpha-admin', 'admin');
    const mutationId = `demoted-replay-${randomUUID()}`;
    const first = await request('/api/v1/admin/settings', {
      method: 'PATCH',
      token,
      body: { registrationEnabled: true },
      headers: { 'idempotency-key': mutationId },
    });
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.body, { registrationEnabled: true });

    db.prepare("UPDATE users SET role = 'user' WHERE id = 'alpha-admin'").run();
    try {
      const changesAfterDemotion = totalChanges();
      const replay = await request('/api/v1/admin/settings', {
        method: 'PATCH',
        token,
        body: { registrationEnabled: true },
        headers: { 'idempotency-key': mutationId },
      });
      assertError(replay, 403, 'ADMIN_REQUIRED');
      assertNoStore(replay);
      assert.equal(replay.headers.get('idempotent-replay'), null);
      assert.equal(totalChanges(), changesAfterDemotion);
    } finally {
      db.prepare("UPDATE users SET role = 'admin' WHERE id = 'alpha-admin'").run();
    }
  });

  test('overview exposes only exact aggregates and a global admin still cannot read snapshots', async () => {
    const token = accessToken('admin-root', 'admin');
    const result = await request('/api/v1/admin/overview', { token });
    assert.equal(result.status, 200, result.text);
    assertNoStore(result);
    exactKeys(result.body, [
      'serverInstanceId',
      'generatedAt',
      'registrationEnabled',
      'counts',
    ]);
    assert.equal(result.body.serverInstanceId, instanceId);
    assert.equal(result.body.registrationEnabled, true);
    assert.ok(Number.isFinite(Date.parse(String(result.body.generatedAt))));
    assertObject(result.body.counts, 'counts');
    exactKeys(result.body.counts, ['users', 'sessions']);
    assertObject(result.body.counts.users, 'counts.users');
    assertObject(result.body.counts.sessions, 'counts.sessions');
    assert.deepEqual(result.body.counts.users, { total: 10, admins: 2 });
    assert.deepEqual(result.body.counts.sessions, {
      total: 4,
      initializing: 1,
      active: 1,
      closed: 1,
      deleted: 1,
    });

    for (const secret of [
      'Sensitive active title',
      'SECRET-CONTROLLER',
      'SECRET-CALLSIGN',
      'SECRET-QTH',
      'SECRET-REMARKS',
      'sensitive-sync-id',
    ]) {
      assert.equal(result.text.includes(secret), false, `overview leaked ${secret}`);
    }

    const snapshot = await request('/api/v1/sessions/session-active/snapshot', { token });
    assertError(snapshot, 404, 'NOT_FOUND');
  });

  test('settings writes require idempotency, validate strictly and replay without duplicate audit', async () => {
    const token = accessToken('admin-root', 'admin');
    const initial = await request('/api/v1/admin/settings', { token });
    assert.equal(initial.status, 200, initial.text);
    assertNoStore(initial);
    assert.deepEqual(initial.body, { registrationEnabled: true });

    const invalidBodies: Array<[unknown, number, string, boolean]> = [
      [{}, 422, 'VALIDATION_FAILED', true],
      [{ registrationEnabled: 'false' }, 422, 'VALIDATION_FAILED', true],
      [{ registrationEnabled: 0 }, 422, 'VALIDATION_FAILED', true],
      [{ registrationEnabled: 1 }, 422, 'VALIDATION_FAILED', true],
      [{ registrationEnabled: null }, 422, 'VALIDATION_FAILED', true],
      [{ registrationEnabled: false, unexpected: true }, 422, 'VALIDATION_FAILED', true],
      // express.json() rejects a top-level JSON primitive before route middleware runs,
      // while the app-level control-plane middleware still marks the response no-store.
      [null, 400, 'INVALID_JSON', true],
      [[], 422, 'VALIDATION_FAILED', true],
    ];
    for (const [body, status, code, routeReached] of invalidBodies) {
      const beforeChanges = totalChanges();
      const beforeRow = settingsRow();
      const result = await request('/api/v1/admin/settings', {
        method: 'PATCH',
        token,
        body,
        headers: idempotencyHeaders('invalid-settings'),
      });
      assertError(result, status, code);
      if (routeReached) assertNoStore(result);
      assert.equal(totalChanges(), beforeChanges, `invalid body caused a SQLite write: ${JSON.stringify(body)}`);
      assert.deepEqual(settingsRow(), beforeRow);
    }

    for (const headers of [undefined, { 'idempotency-key': 'contains spaces' }]) {
      const beforeChanges = totalChanges();
      const result = await request('/api/v1/admin/settings', {
        method: 'PATCH',
        token,
        body: { registrationEnabled: false },
        headers,
      });
      assertError(result, 400, 'IDEMPOTENCY_KEY_REQUIRED');
      assertNoStore(result);
      assert.equal(totalChanges(), beforeChanges);
      assert.equal(settingsRow().registration_enabled, 1);
    }

    const auditBefore = auditCount(
      "WHERE action = 'settings.registration.updated' AND actor_user_id = ?",
      ['admin-root'],
    );
    const settingsMutationId = `settings-off-${randomUUID()}`;

    const patched = await request('/api/v1/admin/settings', {
      method: 'PATCH',
      token,
      body: { registrationEnabled: false },
      headers: { 'idempotency-key': settingsMutationId },
    });
    assert.equal(patched.status, 200, patched.text);
    assertNoStore(patched);
    assert.deepEqual(patched.body, { registrationEnabled: false });
    assert.deepEqual(settingsRow(), {
      registration_enabled: 0,
      instance_id: instanceId,
      invite_hmac_fingerprint: fingerprint,
    });

    const afterFirstPatch = totalChanges();
    const replay = await request('/api/v1/admin/settings', {
      method: 'PATCH',
      token,
      body: { registrationEnabled: false },
      headers: { 'idempotency-key': settingsMutationId },
    });
    assert.equal(replay.status, 200, replay.text);
    assert.deepEqual(replay.body, patched.body);
    assert.equal(replay.headers.get('idempotent-replay'), 'true');
    assert.equal(totalChanges(), afterFirstPatch, 'settings replay must perform zero writes');

    const conflictingReplay = await request('/api/v1/admin/settings', {
      method: 'PATCH',
      token,
      body: { registrationEnabled: true },
      headers: { 'idempotency-key': settingsMutationId },
    });
    assertError(conflictingReplay, 409, 'MUTATION_ID_REUSED');
    assert.equal(totalChanges(), afterFirstPatch);

    const readBack = await request('/api/v1/admin/settings', { token });
    assert.equal(readBack.status, 200, readBack.text);
    assert.deepEqual(readBack.body, { registrationEnabled: false });

    const restored = await request('/api/v1/admin/settings', {
      method: 'PATCH',
      token,
      body: { registrationEnabled: true },
      headers: idempotencyHeaders('restore-settings'),
    });
    assert.equal(restored.status, 200, restored.text);
    assert.deepEqual(restored.body, { registrationEnabled: true });
    assert.deepEqual(settingsRow(), {
      registration_enabled: 1,
      instance_id: instanceId,
      invite_hmac_fingerprint: fingerprint,
    });
    assert.equal(
      auditCount(
        "WHERE action = 'settings.registration.updated' AND actor_user_id = ?",
        ['admin-root'],
      ),
      auditBefore + 2,
      'one audit event is expected per actual settings change, never per replay',
    );
  });

  test('users has deterministic pagination and returns an exact non-sensitive DTO', async () => {
    const token = accessToken('admin-root', 'admin');
    const first = await request('/api/v1/admin/users?page=1&pageSize=2', { token });
    assert.equal(first.status, 200, first.text);
    assertNoStore(first);
    exactKeys(first.body, ['items', 'page', 'pageSize', 'total', 'totalPages']);
    assert.deepEqual(
      {
        page: first.body.page,
        pageSize: first.body.pageSize,
        total: first.body.total,
        totalPages: first.body.totalPages,
      },
      { page: 1, pageSize: 2, total: 10, totalPages: 5 },
    );
    assert.ok(Array.isArray(first.body.items));
    assert.deepEqual(first.body.items, [
      {
        id: 'stable-b',
        username: 'sameb',
        role: 'user',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      {
        id: 'stable-a',
        username: 'samea',
        role: 'user',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ]);

    const second = await request('/api/v1/admin/users?page=2&pageSize=2', { token });
    assert.equal(second.status, 200, second.text);
    assert.ok(Array.isArray(second.body.items));
    assert.deepEqual(
      second.body.items.map((item) => {
        assertObject(item, 'user item');
        return item.id;
      }),
      ['admin-root', 'alpha-user'],
    );

    for (const item of [...first.body.items, ...second.body.items] as unknown[]) {
      assertObject(item, 'user item');
      exactKeys(item, ['id', 'username', 'role', 'createdAt']);
    }
    assert.equal(first.text.includes('NEVER_EXPOSE_PASSWORD_HASH'), false);
    assert.equal(first.text.includes('password_hash'), false);
    assert.equal(first.text.includes('updated_at'), false);
  });

  test('users combines case-insensitive q and role filters', async () => {
    const token = accessToken('admin-root', 'admin');
    const admin = await request('/api/v1/admin/users?q=ALPHA&role=admin', { token });
    assert.equal(admin.status, 200, admin.text);
    assert.deepEqual(admin.body, {
      items: [
        {
          id: 'alpha-admin',
          username: 'alphaadmin',
          role: 'admin',
          createdAt: '2026-03-01T00:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    });

    const user = await request('/api/v1/admin/users?q=alpha&role=user', { token });
    assert.equal(user.status, 200, user.text);
    assert.ok(Array.isArray(user.body.items));
    assert.deepEqual(
      user.body.items.map((item) => {
        assertObject(item, 'user item');
        return item.id;
      }),
      ['alpha-user'],
    );
  });

  test('users treats LIKE metacharacters and SQL injection text as literals', async () => {
    const token = accessToken('admin-root', 'admin');
    const searches: Array<[string, string]> = [
      ['%', 'literal-percent'],
      ['_', 'literal-underscore'],
      ['\\', 'literal-backslash'],
    ];
    for (const [q, expectedId] of searches) {
      const params = new URLSearchParams({ q });
      const result = await request(`/api/v1/admin/users?${params}`, { token });
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.total, 1);
      assert.ok(Array.isArray(result.body.items));
      assert.equal(result.body.items.length, 1);
      assertObject(result.body.items[0], 'user item');
      assert.equal(result.body.items[0].id, expectedId);
    }

    const injection = new URLSearchParams({ q: "' OR 1=1 --" });
    const result = await request(`/api/v1/admin/users?${injection}`, { token });
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.body, {
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0,
    });
  });

  test('users enforces query bounds, rejects unknown and repeated query parameters', async () => {
    const token = accessToken('admin-root', 'admin');

    const maximum = await request('/api/v1/admin/users?page=1000000&pageSize=100', { token });
    assert.equal(maximum.status, 200, maximum.text);
    assert.deepEqual(maximum.body, {
      items: [],
      page: 1_000_000,
      pageSize: 100,
      total: 10,
      totalPages: 1,
    });

    const whitespace = await request('/api/v1/admin/users?q=%20%20%20', { token });
    assert.equal(whitespace.status, 200, whitespace.text);
    assert.equal(whitespace.body.total, 10);

    const invalidQueries = [
      'page=0',
      'page=-1',
      'page=01',
      'page=1.0',
      'page=1000001',
      'pageSize=0',
      'pageSize=101',
      'role=owner',
      `q=${'a'.repeat(65)}`,
      'unknown=value',
      'q=a&q=b',
      'role=admin&role=user',
      'page=1&page=2',
      'pageSize=10&pageSize=20',
    ];
    for (const query of invalidQueries) {
      const result = await request(`/api/v1/admin/users?${query}`, { token });
      assertError(result, 422, 'VALIDATION_FAILED');
      assertNoStore(result);
    }
  });

  test('role and refresh-token writes require strict bodies and idempotency keys', async () => {
    const token = accessToken('admin-root', 'admin');
    const roleBefore = db.prepare('SELECT role FROM users WHERE id = ?').pluck().get('stable-a');
    const auditBefore = auditCount();

    const missingRoleKey = await request('/api/v1/admin/users/stable-a/role', {
      method: 'PATCH',
      token,
      body: { role: 'admin' },
    });
    assertError(missingRoleKey, 400, 'IDEMPOTENCY_KEY_REQUIRED');

    const invalidRoleBodies: unknown[] = [
      {},
      { role: 'owner' },
      { role: 1 },
      { role: null },
      { role: 'admin', unexpected: true },
      [],
    ];
    for (const body of invalidRoleBodies) {
      const mutationId = `invalid-role-${randomUUID()}`;
      const result = await request('/api/v1/admin/users/stable-a/role', {
        method: 'PATCH',
        token,
        body,
        headers: { 'idempotency-key': mutationId },
      });
      assertError(result, 422, 'VALIDATION_FAILED');
      assert.equal(
        db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(mutationId),
        0,
      );
    }

    const missingRoleTargetMutation = `missing-role-target-${randomUUID()}`;
    const missingRoleTarget = await request('/api/v1/admin/users/missing-user/role', {
      method: 'PATCH',
      token,
      body: { role: 'admin' },
      headers: { 'idempotency-key': missingRoleTargetMutation },
    });
    assertError(missingRoleTarget, 404, 'USER_NOT_FOUND');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
        missingRoleTargetMutation,
      ),
      0,
    );

    const missingRevokeKey = await request(
      '/api/v1/admin/users/stable-a/revoke-refresh-tokens',
      { method: 'POST', token, body: {} },
    );
    assertError(missingRevokeKey, 400, 'IDEMPOTENCY_KEY_REQUIRED');

    const rawBodyMutation = `raw-revoke-${randomUUID()}`;
    const beforeRawBody = totalChanges();
    const rawBody = await request('/api/v1/admin/users/stable-a/revoke-refresh-tokens', {
      method: 'POST',
      token,
      rawBody: 'this is not an empty JSON command',
      headers: {
        'content-type': 'text/plain',
        'idempotency-key': rawBodyMutation,
      },
    });
    assertError(rawBody, 415, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(totalChanges(), beforeRawBody);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
        rawBodyMutation,
      ),
      0,
    );

    for (const body of [{ unexpected: true }, { reason: 'not accepted' }, []]) {
      const mutationId = `invalid-revoke-${randomUUID()}`;
      const result = await request('/api/v1/admin/users/stable-a/revoke-refresh-tokens', {
        method: 'POST',
        token,
        body,
        headers: { 'idempotency-key': mutationId },
      });
      assertError(result, 422, 'VALIDATION_FAILED');
      assert.equal(
        db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(mutationId),
        0,
      );
    }

    const missingRevokeTargetMutation = `missing-revoke-target-${randomUUID()}`;
    const missingRevokeTarget = await request(
      '/api/v1/admin/users/missing-user/revoke-refresh-tokens',
      {
        method: 'POST',
        token,
        body: {},
        headers: { 'idempotency-key': missingRevokeTargetMutation },
      },
    );
    assertError(missingRevokeTarget, 404, 'USER_NOT_FOUND');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
        missingRevokeTargetMutation,
      ),
      0,
    );

    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').pluck().get('stable-a'), roleBefore);
    assert.equal(auditCount(), auditBefore);
  });

  test('self role changes are forbidden and the final administrator gets the specific invariant error', async () => {
    const token = accessToken('admin-root', 'admin');
    const auditBefore = auditCount();

    const selfMutation = `self-role-${randomUUID()}`;
    const selfChange = await request('/api/v1/admin/users/admin-root/role', {
      method: 'PATCH',
      token,
      body: { role: 'user' },
      headers: { 'idempotency-key': selfMutation },
    });
    assertError(selfChange, 409, 'SELF_ROLE_CHANGE_FORBIDDEN');
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').pluck().get('admin-root'), 'admin');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(selfMutation),
      0,
    );

    db.prepare("UPDATE users SET role = 'user' WHERE id = 'alpha-admin'").run();
    try {
      const lastAdminMutation = `last-admin-${randomUUID()}`;
      const lastAdmin = await request('/api/v1/admin/users/admin-root/role', {
        method: 'PATCH',
        token,
        body: { role: 'user' },
        headers: { 'idempotency-key': lastAdminMutation },
      });
      assertError(lastAdmin, 409, 'LAST_ADMIN_REQUIRED');
      assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').pluck().get('admin-root'), 'admin');
      assert.equal(
        db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
          lastAdminMutation,
        ),
        0,
      );
      assert.equal(auditCount(), auditBefore);
      assert.throws(
        () => db.prepare("UPDATE users SET role = 'user' WHERE id = 'admin-root'").run(),
        /at least one administrator is required/,
        'the database trigger must defend the last-admin invariant too',
      );
    } finally {
      db.prepare("UPDATE users SET role = 'admin' WHERE id = 'alpha-admin'").run();
    }
  });

  test('role changes revoke only active refresh tokens and replay the exact atomic result', async () => {
    const token = accessToken('admin-root', 'admin');
    const activeOne = insertRefreshToken('stable-a');
    const activeTwo = insertRefreshToken('stable-a');
    const expired = insertRefreshToken('stable-a', {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const preRevokedAt = new Date(Date.now() - 30_000).toISOString();
    const preRevoked = insertRefreshToken('stable-a', { revokedAt: preRevokedAt });
    const mutationId = `promote-stable-a-${randomUUID()}`;
    const auditBefore = auditCount(
      "WHERE action = 'user.role.updated' AND target_user_id = ?",
      ['stable-a'],
    );

    const promoted = await request('/api/v1/admin/users/stable-a/role', {
      method: 'PATCH',
      token,
      body: { role: 'admin' },
      headers: { 'idempotency-key': mutationId },
    });
    assert.equal(promoted.status, 200, promoted.text);
    assertNoStore(promoted);
    exactKeys(promoted.body, [
      'user',
      'changed',
      'revokedRefreshTokenCount',
      'reauthenticationRequired',
      'auditEventId',
    ]);
    assertObject(promoted.body.user, 'promoted user');
    exactKeys(promoted.body.user, ['id', 'username', 'role', 'createdAt', 'updatedAt']);
    assert.deepEqual(
      {
        id: promoted.body.user.id,
        username: promoted.body.user.username,
        role: promoted.body.user.role,
        createdAt: promoted.body.user.createdAt,
      },
      {
        id: 'stable-a',
        username: 'samea',
        role: 'admin',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    );
    assert.ok(Number.isFinite(Date.parse(String(promoted.body.user.updatedAt))));
    assert.equal(promoted.body.changed, true);
    assert.equal(promoted.body.revokedRefreshTokenCount, 2);
    assert.equal(promoted.body.reauthenticationRequired, true);
    assert.equal(typeof promoted.body.auditEventId, 'string');

    const tokenRows = db.prepare(`
      SELECT id, revoked_at FROM refresh_tokens
      WHERE id IN (?, ?, ?, ?)
      ORDER BY id
    `).all(activeOne, activeTwo, expired, preRevoked) as Array<{
      id: string;
      revoked_at: string | null;
    }>;
    const byId = new Map(tokenRows.map((row) => [row.id, row.revoked_at]));
    assert.ok(byId.get(activeOne));
    assert.ok(byId.get(activeTwo));
    assert.equal(byId.get(expired), null, 'expired refresh tokens are not active and stay untouched');
    assert.equal(byId.get(preRevoked), preRevokedAt);
    assert.equal(
      auditCount("WHERE action = 'user.role.updated' AND target_user_id = ?", ['stable-a']),
      auditBefore + 1,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(mutationId),
      1,
    );

    const changesAfterPromotion = totalChanges();
    const replay = await request('/api/v1/admin/users/stable-a/role', {
      method: 'PATCH',
      token,
      body: { role: 'admin' },
      headers: { 'idempotency-key': mutationId },
    });
    assert.equal(replay.status, 200, replay.text);
    assert.deepEqual(replay.body, promoted.body);
    assert.equal(replay.headers.get('idempotent-replay'), 'true');
    assert.equal(totalChanges(), changesAfterPromotion);

    const crossPath = await request('/api/v1/admin/users/stable-b/role', {
      method: 'PATCH',
      token,
      body: { role: 'admin' },
      headers: { 'idempotency-key': mutationId },
    });
    assertError(crossPath, 409, 'MUTATION_ID_REUSED');

    const crossActor = await request('/api/v1/admin/users/stable-a/role', {
      method: 'PATCH',
      token: accessToken('alpha-admin', 'admin'),
      body: { role: 'admin' },
      headers: { 'idempotency-key': mutationId },
    });
    assertError(crossActor, 409, 'MUTATION_ID_REUSED');
    assert.equal(totalChanges(), changesAfterPromotion);

    const noopMutation = `noop-role-${randomUUID()}`;
    const noop = await request('/api/v1/admin/users/stable-a/role', {
      method: 'PATCH',
      token,
      body: { role: 'admin' },
      headers: { 'idempotency-key': noopMutation },
    });
    assert.equal(noop.status, 200, noop.text);
    assert.equal(noop.body.changed, false);
    assert.equal(noop.body.revokedRefreshTokenCount, 0);
    assert.equal(noop.body.reauthenticationRequired, false);
    assert.equal(noop.body.auditEventId, null);
    assert.equal(
      auditCount("WHERE action = 'user.role.updated' AND target_user_id = ?", ['stable-a']),
      auditBefore + 1,
      'a no-op role request must not be audited',
    );

    const activeBeforeDemotion = insertRefreshToken('stable-a');
    const demoted = await request('/api/v1/admin/users/stable-a/role', {
      method: 'PATCH',
      token,
      body: { role: 'user' },
      headers: idempotencyHeaders('demote-stable-a'),
    });
    assert.equal(demoted.status, 200, demoted.text);
    assert.equal(demoted.body.changed, true);
    assert.equal(demoted.body.revokedRefreshTokenCount, 1);
    assert.equal(demoted.body.reauthenticationRequired, true);
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').pluck().get('stable-a'), 'user');
    assert.ok(
      db.prepare('SELECT revoked_at FROM refresh_tokens WHERE id = ?').pluck().get(activeBeforeDemotion),
    );

    const staleTargetToken = accessToken('stable-a', 'admin');
    const staleTargetRequest = await request('/api/v1/admin/overview', {
      token: staleTargetToken,
    });
    assertError(staleTargetRequest, 403, 'ADMIN_REQUIRED');
  });

  test('refresh-token revoke is idempotent, permits an empty body and audits only real revocations', async () => {
    const token = accessToken('admin-root', 'admin');
    const activeOne = insertRefreshToken('stable-b');
    const activeTwo = insertRefreshToken('stable-b');
    const expired = insertRefreshToken('stable-b', {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const alreadyRevokedAt = new Date(Date.now() - 30_000).toISOString();
    const alreadyRevoked = insertRefreshToken('stable-b', { revokedAt: alreadyRevokedAt });
    const auditBefore = auditCount(
      "WHERE action = 'user.refresh_tokens.revoked' AND target_user_id = ?",
      ['stable-b'],
    );
    const mutationId = `revoke-stable-b-${randomUUID()}`;

    const revoked = await request('/api/v1/admin/users/stable-b/revoke-refresh-tokens', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': mutationId },
    });
    assert.equal(revoked.status, 200, revoked.text);
    assertNoStore(revoked);
    exactKeys(revoked.body, [
      'userId',
      'revokedRefreshTokenCount',
      'processedAt',
      'accessTokensRemainValidUntilExpiry',
      'auditEventId',
    ]);
    assert.equal(revoked.body.userId, 'stable-b');
    assert.equal(revoked.body.revokedRefreshTokenCount, 2);
    assert.ok(Number.isFinite(Date.parse(String(revoked.body.processedAt))));
    assert.equal(revoked.body.accessTokensRemainValidUntilExpiry, true);
    assert.equal(typeof revoked.body.auditEventId, 'string');

    const tokenRows = db.prepare(`
      SELECT id, revoked_at FROM refresh_tokens WHERE id IN (?, ?, ?, ?)
    `).all(activeOne, activeTwo, expired, alreadyRevoked) as Array<{
      id: string;
      revoked_at: string | null;
    }>;
    const byId = new Map(tokenRows.map((row) => [row.id, row.revoked_at]));
    assert.ok(byId.get(activeOne));
    assert.ok(byId.get(activeTwo));
    assert.equal(byId.get(expired), null);
    assert.equal(byId.get(alreadyRevoked), alreadyRevokedAt);
    assert.equal(
      auditCount("WHERE action = 'user.refresh_tokens.revoked' AND target_user_id = ?", ['stable-b']),
      auditBefore + 1,
    );

    const changesAfterRevoke = totalChanges();
    const replay = await request('/api/v1/admin/users/stable-b/revoke-refresh-tokens', {
      method: 'POST',
      token,
      body: {},
      headers: { 'idempotency-key': mutationId },
    });
    assert.equal(replay.status, 200, replay.text);
    assert.deepEqual(replay.body, revoked.body);
    assert.equal(replay.headers.get('idempotent-replay'), 'true');
    assert.equal(totalChanges(), changesAfterRevoke);

    const noopMutation = `noop-revoke-${randomUUID()}`;
    const noop = await request('/api/v1/admin/users/stable-b/revoke-refresh-tokens', {
      method: 'POST',
      token,
      body: {},
      headers: { 'idempotency-key': noopMutation },
    });
    assert.equal(noop.status, 200, noop.text);
    assert.equal(noop.body.revokedRefreshTokenCount, 0);
    assert.equal(noop.body.auditEventId, null);
    assert.equal(
      auditCount("WHERE action = 'user.refresh_tokens.revoked' AND target_user_id = ?", ['stable-b']),
      auditBefore + 1,
      'a no-op revoke request must not be audited',
    );
  });

  test('role, token, audit and idempotency writes roll back together when audit insertion fails', async () => {
    const token = accessToken('admin-root', 'admin');
    const refreshTokenId = insertRefreshToken('alpha-user');
    const mutationId = `forced-rollback-${randomUUID()}`;
    const auditBefore = auditCount();
    db.exec(`
      CREATE TEMP TRIGGER fail_admin_audit_insert
      BEFORE INSERT ON admin_audit_events
      BEGIN
        SELECT RAISE(ABORT, 'forced admin audit failure');
      END;
    `);

    try {
      const result = await request('/api/v1/admin/users/alpha-user/role', {
        method: 'PATCH',
        token,
        body: { role: 'admin' },
        headers: { 'idempotency-key': mutationId },
      });
      assertError(result, 500, 'INTERNAL_ERROR');
      assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').pluck().get('alpha-user'), 'user');
      assert.equal(
        db.prepare('SELECT revoked_at FROM refresh_tokens WHERE id = ?').pluck().get(refreshTokenId),
        null,
      );
      assert.equal(auditCount(), auditBefore);
      assert.equal(
        db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
          mutationId,
        ),
        0,
      );
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_admin_audit_insert');
    }
  });

  test('audit events use a strict filtered cursor contract and expose only whitelisted fields', async () => {
    const token = accessToken('admin-root', 'admin');
    const roleEvents = await request(
      '/api/v1/admin/audit-events?action=user.role.updated&limit=1',
      { token },
    );
    assert.equal(roleEvents.status, 200, roleEvents.text);
    assertNoStore(roleEvents);
    exactKeys(roleEvents.body, ['items', 'pageInfo']);
    assert.ok(Array.isArray(roleEvents.body.items));
    assert.equal(roleEvents.body.items.length, 1);
    assertObject(roleEvents.body.pageInfo, 'audit pageInfo');
    exactKeys(roleEvents.body.pageInfo, ['limit', 'hasMore', 'nextCursor']);
    assert.equal(roleEvents.body.pageInfo.limit, 1);
    assert.equal(roleEvents.body.pageInfo.hasMore, true);
    assert.equal(typeof roleEvents.body.pageInfo.nextCursor, 'string');

    const firstItem = roleEvents.body.items[0];
    assertObject(firstItem, 'audit item');
    exactKeys(firstItem, [
      'auditEventId',
      'action',
      'actorUserId',
      'targetUserId',
      'before',
      'after',
      'details',
      'requestId',
      'mutationId',
      'occurredAt',
    ]);
    assert.equal(firstItem.action, 'user.role.updated');
    assert.equal(firstItem.actorUserId, 'admin-root');
    assert.equal(firstItem.targetUserId, 'stable-a');
    assertObject(firstItem.before, 'audit before');
    assertObject(firstItem.after, 'audit after');
    assertObject(firstItem.details, 'audit details');
    assert.ok(Number.isFinite(Date.parse(String(firstItem.occurredAt))));

    const secondPage = await request(
      `/api/v1/admin/audit-events?action=user.role.updated&limit=1&cursor=${encodeURIComponent(
        String(roleEvents.body.pageInfo.nextCursor),
      )}`,
      { token },
    );
    assert.equal(secondPage.status, 200, secondPage.text);
    assert.ok(Array.isArray(secondPage.body.items));
    assert.equal(secondPage.body.items.length, 1);
    assertObject(secondPage.body.items[0], 'second audit item');
    assert.notEqual(secondPage.body.items[0].auditEventId, firstItem.auditEventId);

    const targetFilter = await request(
      '/api/v1/admin/audit-events?targetUserId=stable-b&action=user.refresh_tokens.revoked',
      { token },
    );
    assert.equal(targetFilter.status, 200, targetFilter.text);
    assert.ok(Array.isArray(targetFilter.body.items));
    assert.ok(targetFilter.body.items.length >= 1);
    for (const rawItem of targetFilter.body.items) {
      assertObject(rawItem, 'target-filtered audit item');
      assert.equal(rawItem.targetUserId, 'stable-b');
      assert.equal(rawItem.action, 'user.refresh_tokens.revoked');
    }

    const occurredAt = String(firstItem.occurredAt);
    const windowEnd = new Date(Date.parse(occurredAt) + 1).toISOString();
    const timeWindow = new URLSearchParams({
      action: 'user.role.updated',
      from: occurredAt,
      to: windowEnd,
      limit: '100',
    });
    const windowResult = await request(`/api/v1/admin/audit-events?${timeWindow}`, { token });
    assert.equal(windowResult.status, 200, windowResult.text);
    assert.ok(Array.isArray(windowResult.body.items));
    assert.ok(
      windowResult.body.items.some((item) => {
        assertObject(item, 'time-window audit item');
        return item.auditEventId === firstItem.auditEventId;
      }),
    );

    const mismatchedCursor = await request(
      `/api/v1/admin/audit-events?action=settings.registration.updated&limit=1&cursor=${encodeURIComponent(
        String(roleEvents.body.pageInfo.nextCursor),
      )}`,
      { token },
    );
    assertError(mismatchedCursor, 422, 'VALIDATION_FAILED');

    const decodedCursor = JSON.parse(
      Buffer.from(String(roleEvents.body.pageInfo.nextCursor), 'base64url').toString('utf8'),
    ) as JsonObject;
    decodedCursor.id = randomUUID();
    const tamperedCursor = Buffer.from(JSON.stringify(decodedCursor), 'utf8').toString('base64url');
    const tamperedResult = await request(
      `/api/v1/admin/audit-events?action=user.role.updated&limit=1&cursor=${encodeURIComponent(
        tamperedCursor,
      )}`,
      { token },
    );
    assertError(tamperedResult, 422, 'VALIDATION_FAILED');

    const invalidQueries = [
      'unknown=value',
      'action=owner.promoted',
      'action=user.role.updated&action=user.role.updated',
      'actorUserId=a&actorUserId=b',
      'targetUserId=a&targetUserId=b',
      'from=not-a-date',
      'to=not-a-date',
      'from=2026-07-12T01%3A00%3A00.000Z&to=2026-07-12T01%3A00%3A00.000Z',
      'cursor=not-a-valid-cursor',
      'limit=0',
      'limit=01',
      'limit=101',
      `action=${encodeURIComponent("' OR 1=1 --")}`,
    ];
    for (const query of invalidQueries) {
      const result = await request(`/api/v1/admin/audit-events?${query}`, { token });
      assertError(result, 422, 'VALIDATION_FAILED');
      assertNoStore(result);
    }

    const allAudit = await request('/api/v1/admin/audit-events?limit=100', { token });
    assert.equal(allAudit.status, 200, allAudit.text);
    assert.ok(Array.isArray(allAudit.body.items));
    for (let index = 1; index < allAudit.body.items.length; index += 1) {
      const previous = allAudit.body.items[index - 1];
      const current = allAudit.body.items[index];
      assertObject(previous, 'previous audit item');
      assertObject(current, 'current audit item');
      const previousKey = `${previous.occurredAt}\n${previous.auditEventId}`;
      const currentKey = `${current.occurredAt}\n${current.auditEventId}`;
      assert.ok(previousKey >= currentKey, 'audit cursor ordering must be stable and descending');
    }
    for (const secret of [
      'NEVER_EXPOSE_PASSWORD_HASH',
      'TEST_TOKEN_HASH_',
      'Sensitive active title',
      'SECRET-CALLSIGN',
      'SECRET-REMARKS',
    ]) {
      assert.equal(allAudit.text.includes(secret), false, `audit response leaked ${secret}`);
    }
    assert.throws(
      () => db.prepare('UPDATE admin_audit_events SET details_json = ? WHERE id = ?').run(
        '{}',
        firstItem.auditEventId,
      ),
      /administrator audit events are append-only/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM admin_audit_events WHERE id = ?').run(
        firstItem.auditEventId,
      ),
      /administrator audit events are append-only/,
    );
  });

  test('settings and overview reject a corrupt persisted registration flag', async () => {
    const token = accessToken('admin-root', 'admin');
    db.prepare('UPDATE server_settings SET registration_enabled = 2 WHERE id = 1').run();

    try {
      for (const path of ['/api/v1/admin/settings', '/api/v1/admin/overview']) {
        const result = await request(path, { token });
        assertError(result, 500, 'SERVER_SETTINGS_INVALID');
        assertNoStore(result);
      }
      assert.deepEqual(settingsRow(), {
        registration_enabled: 2,
        instance_id: instanceId,
        invite_hmac_fingerprint: fingerprint,
      });
    } finally {
      db.prepare('UPDATE server_settings SET registration_enabled = 1 WHERE id = 1').run();
    }
  });
});
