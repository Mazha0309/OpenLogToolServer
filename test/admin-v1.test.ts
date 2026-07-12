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
    options: { method?: string; token?: string; body?: unknown } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': randomUUID(),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

  test('settings accepts only a strict boolean and invalid PATCH requests perform zero writes', async () => {
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
      // express.json() rejects a top-level JSON primitive before route middleware runs.
      [null, 400, 'INVALID_JSON', false],
      [[], 422, 'VALIDATION_FAILED', true],
    ];
    for (const [body, status, code, routeReached] of invalidBodies) {
      const beforeChanges = totalChanges();
      const beforeRow = settingsRow();
      const result = await request('/api/v1/admin/settings', {
        method: 'PATCH',
        token,
        body,
      });
      assertError(result, status, code);
      if (routeReached) assertNoStore(result);
      assert.equal(totalChanges(), beforeChanges, `invalid body caused a SQLite write: ${JSON.stringify(body)}`);
      assert.deepEqual(settingsRow(), beforeRow);
    }

    const patched = await request('/api/v1/admin/settings', {
      method: 'PATCH',
      token,
      body: { registrationEnabled: false },
    });
    assert.equal(patched.status, 200, patched.text);
    assertNoStore(patched);
    assert.deepEqual(patched.body, { registrationEnabled: false });
    assert.deepEqual(settingsRow(), {
      registration_enabled: 0,
      instance_id: instanceId,
      invite_hmac_fingerprint: fingerprint,
    });

    const readBack = await request('/api/v1/admin/settings', { token });
    assert.equal(readBack.status, 200, readBack.text);
    assert.deepEqual(readBack.body, { registrationEnabled: false });

    const restored = await request('/api/v1/admin/settings', {
      method: 'PATCH',
      token,
      body: { registrationEnabled: true },
    });
    assert.equal(restored.status, 200, restored.text);
    assert.deepEqual(restored.body, { registrationEnabled: true });
    assert.deepEqual(settingsRow(), {
      registration_enabled: 1,
      instance_id: instanceId,
      invite_hmac_fingerprint: fingerprint,
    });
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
