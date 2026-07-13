import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { createApp } from '../src/app';
import { getRealtimeHub } from '../src/collaboration/realtime';
import type { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';

type JsonObject = Record<string, any>;

interface HttpResult {
  status: number;
  headers: Headers;
  body: JsonObject;
  text: string;
}

interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; role: string };
}

const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'account-auth-test-jwt-secret-54f57472-c5d6-4a07-a903-cacb17dc9a87',
  jwtIssuer: 'openlogtool-account-auth-test',
  bootstrapSecret: 'account-auth-bootstrap-secret-f1eda444-1361-4465',
  inviteHmacKey: 'account-auth-invite-key-6c9905ae-d359-43b0-89ec',
  publicShareHmacKey: 'account-auth-public-key-453c0254-f09f-43b0-99e5',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

function assertError(result: HttpResult, status: number, code: string): JsonObject {
  assert.equal(result.status, status, result.text);
  assert.ok(result.body.error && typeof result.body.error === 'object', result.text);
  assert.equal(result.body.error.code, code, result.text);
  return result.body.error;
}

function authResult(result: HttpResult, status = 200): AuthResult {
  assert.equal(result.status, status, result.text);
  assert.deepEqual(
    Object.keys(result.body).sort(),
    ['accessToken', 'accessTokenExpiresIn', 'refreshToken', 'refreshTokenExpiresAt', 'user'].sort(),
  );
  assert.equal(typeof result.body.accessToken, 'string');
  assert.equal(typeof result.body.refreshToken, 'string');
  assert.deepEqual(Object.keys(result.body.user).sort(), ['id', 'role', 'username']);
  return result.body as AuthResult;
}

describe('v1 account security, Web auth and member catalogs', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let member: AuthResult;
  let outsider: AuthResult;
  let viewer: AuthResult;

  async function request(
    path: string,
    options: {
      method?: string;
      token?: string;
      cookie?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': randomUUID(),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) as JsonObject : {},
      text,
    };
  }

  async function register(username: string, password: string, deviceId?: string): Promise<AuthResult> {
    return authResult(await request('/api/v1/auth/register', {
      method: 'POST',
      body: { username, password, ...(deviceId ? { deviceId } : {}) },
    }), 201);
  }

  function activeRefreshId(refreshToken: string): string {
    return String(db.prepare(`
      SELECT id FROM refresh_tokens WHERE token_hash = ?
    `).pluck().get(createHash('sha256').update(refreshToken).digest('hex')));
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-account-auth-'));
    db = openDatabase(join(directory, 'account-auth.db'));
    const columns = new Set(
      (db.pragma('table_info(users)') as Array<{ name: string }>).map((row) => row.name),
    );
    for (const column of [
      'disabled_at',
      'deleted_at',
      'must_change_password',
      'auth_version',
      'password_changed_at',
      'username_changed_at',
    ]) {
      assert.ok(columns.has(column), `migration v14 must create users.${column}`);
    }

    const app = createApp({ db, config });
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    authResult(await request('/api/v1/auth/bootstrap', {
      method: 'POST',
      headers: { 'x-bootstrap-secret': config.bootstrapSecret },
      body: { username: 'accountadmin', password: 'Admin-password-123!' },
    }), 201);
    member = await register(
      'memberone',
      'Member-password-123!',
      '11111111-1111-4111-8111-111111111111',
    );
    outsider = await register(
      'outsiderone',
      'Outsider-password-123!',
      '22222222-2222-4222-8222-222222222222',
    );
    viewer = await register('viewerone', 'Viewer-password-123!');
  });

  after(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('account and refresh-family migrations enforce monotonic authentication state', () => {
    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 14').get(),
      { version: 14, name: 'account_security_and_web_sessions' },
    );
    assert.throws(
      () => db.prepare(`
        UPDATE users SET auth_version = auth_version - 1 WHERE id = ?
      `).run(member.user.id),
      /authentication version|CHECK constraint/i,
    );
    assert.equal(
      Number(db.prepare('SELECT auth_version FROM users WHERE id = ?').pluck().get(member.user.id)),
      1,
    );
    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 16').get(),
      { version: 16, name: 'refresh_token_session_families' },
    );
    assert.ok(
      (db.pragma('table_info(refresh_tokens)') as Array<{ name: string }>)
        .some((column) => column.name === 'auth_session_id'),
    );
    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 17').get(),
      { version: 17, name: 'websocket_auth_session_binding' },
    );
    assert.ok(
      (db.pragma('table_info(ws_tickets)') as Array<{ name: string }>)
        .some((column) => column.name === 'auth_session_id'),
    );
    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 18').get(),
      { version: 18, name: 'authentication_credential_version_binding' },
    );
  });

  test('normal v1 clients retain their response contract while Web auth keeps refresh tokens in a strict HttpOnly cookie', async () => {
    const reservedUsername = await request('/api/v1/auth/register', {
      method: 'POST',
      body: { username: `deleted-${randomUUID()}`, password: 'Reserved-password-123!' },
    });
    assertError(reservedUsername, 422, 'VALIDATION_FAILED');

    const normal = authResult(await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'memberone', password: 'Member-password-123!' },
    }));
    const payload = JSON.parse(Buffer.from(normal.accessToken.split('.')[1], 'base64url').toString());
    assert.equal(payload.av, 1);
    assert.equal(typeof payload.sid, 'string');

    const webRegister = await request('/api/v1/web-auth/register', {
      method: 'POST',
      body: {
        username: 'webmember',
        password: 'Web-member-password-123!',
        deviceId: '33333333-3333-4333-8333-333333333333',
      },
    });
    assert.equal(webRegister.status, 201, webRegister.text);
    assert.deepEqual(
      Object.keys(webRegister.body).sort(),
      ['accessToken', 'accessTokenExpiresIn', 'user'].sort(),
    );
    assert.equal('refreshToken' in webRegister.body, false);
    const firstSetCookie = webRegister.headers.get('set-cookie') || '';
    assert.match(firstSetCookie, /^olt_web_refresh=/);
    assert.match(firstSetCookie, /HttpOnly/i);
    assert.match(firstSetCookie, /SameSite=Strict/i);
    assert.match(firstSetCookie, /Path=\/api\/v1\/web-auth/i);
    const firstCookie = firstSetCookie.split(';', 1)[0];

    const me = await request('/api/v1/web-auth/me', {
      token: String(webRegister.body.accessToken),
    });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.username, 'webmember');

    const refreshed = await request('/api/v1/web-auth/refresh', {
      method: 'POST',
      cookie: firstCookie,
      body: {},
    });
    assert.equal(refreshed.status, 200, refreshed.text);
    assert.equal('refreshToken' in refreshed.body, false);
    const secondCookie = (refreshed.headers.get('set-cookie') || '').split(';', 1)[0];
    assert.notEqual(secondCookie, firstCookie);

    const logout = await request('/api/v1/web-auth/logout', {
      method: 'POST',
      cookie: secondCookie,
    });
    assert.equal(logout.status, 204, logout.text);
    assert.match(logout.headers.get('set-cookie') || '', /olt_web_refresh=;/);

    const afterLogout = await request('/api/v1/web-auth/refresh', {
      method: 'POST',
      cookie: secondCookie,
      body: {},
    });
    assertError(afterLogout, 401, 'REFRESH_TOKEN_INVALID');
  });

  test('refresh rotation preserves a server-generated family and revoked access cannot be revived by reusing a device label', async () => {
    const deviceId = '44444444-4444-4444-8444-444444444444';
    const first = await register('familymember', 'Family-password-123!', deviceId);
    const firstPayload = JSON.parse(
      Buffer.from(first.accessToken.split('.')[1], 'base64url').toString(),
    );
    assert.equal(typeof firstPayload.sid, 'string');
    assert.notEqual(firstPayload.sid, deviceId);
    const beforeRotation = await request('/api/v1/account/sessions', {
      token: first.accessToken,
    });
    assert.equal(beforeRotation.status, 200, beforeRotation.text);
    const stableSessionId = beforeRotation.body.items.find(
      (item: JsonObject) => item.current === true,
    )?.sessionId;
    assert.equal(stableSessionId, firstPayload.sid);

    const rotated = authResult(await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: first.refreshToken, deviceId },
    }));
    const rotatedPayload = JSON.parse(
      Buffer.from(rotated.accessToken.split('.')[1], 'base64url').toString(),
    );
    assert.equal(rotatedPayload.sid, firstPayload.sid);
    assert.equal(
      (await request('/api/v1/account', { token: first.accessToken })).status,
      200,
    );

    const concurrentRetry = await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: first.refreshToken, deviceId },
    });
    assertError(concurrentRetry, 409, 'REFRESH_TOKEN_ROTATED');

    const sessions = await request('/api/v1/account/sessions', {
      token: rotated.accessToken,
    });
    assert.equal(sessions.status, 200, sessions.text);
    const current = sessions.body.items.find((item: JsonObject) => item.current === true);
    assert.equal(typeof current?.sessionId, 'string');
    assert.equal(current?.sessionId, stableSessionId);
    assert.equal(typeof current?.lastUsedAt, 'string');

    const now = new Date().toISOString();
    const sessionId = `family-session-${randomUUID()}`;
    db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at
      ) VALUES (?, 'Family Session', 'active', ?, 1, 0, 0, ?, ?)
    `).run(sessionId, first.user.id, now, now);
    db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'owner', 1, ?, ?)
    `).run(randomUUID(), sessionId, first.user.id, now, now);
    const ticket = await request(`/api/v1/sessions/${sessionId}/ws-ticket`, {
      method: 'POST',
      token: rotated.accessToken,
      body: { deviceId, afterSeq: 0 },
    });
    assert.equal(ticket.status, 200, ticket.text);
    const ticketRow = db.prepare(`
      SELECT device_id, auth_session_id
      FROM ws_tickets
      WHERE token_hash = ?
    `).get(createHash('sha256').update(String(ticket.body.ticket)).digest('hex')) as {
      device_id: string;
      auth_session_id: string;
    };
    assert.equal(ticketRow.device_id, deviceId);
    assert.equal(ticketRow.auth_session_id, firstPayload.sid);

    let revokedReason: string | undefined;
    getRealtimeHub(db).add({
      audience: 'member',
      sessionId,
      userId: first.user.id,
      authSessionId: firstPayload.sid,
      ipAddress: '127.0.0.1',
      deliver: () => undefined,
      deliverControl: () => undefined,
      revoke: (reason) => { revokedReason = reason; },
      membershipChanged: () => undefined,
      sessionDeleted: () => undefined,
      close: () => undefined,
    });
    assert.equal((await request(`/api/v1/account/sessions/${current.sessionId}`, {
      method: 'DELETE',
      token: rotated.accessToken,
    })).status, 204);
    assert.equal(revokedReason, 'DEVICE_SESSION_REVOKED');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM ws_tickets WHERE auth_session_id = ?').pluck()
        .get(firstPayload.sid),
      0,
    );
    assertError(await request('/api/v1/account', { token: first.accessToken }), 401, 'TOKEN_REVOKED');
    assertError(await request('/api/v1/account', { token: rotated.accessToken }), 401, 'TOKEN_REVOKED');

    const relogin = authResult(await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'familymember', password: 'Family-password-123!', deviceId },
    }));
    const reloginPayload = JSON.parse(
      Buffer.from(relogin.accessToken.split('.')[1], 'base64url').toString(),
    );
    assert.notEqual(reloginPayload.sid, firstPayload.sid);
    assert.equal((await request('/api/v1/account', { token: relogin.accessToken })).status, 200);
    assertError(await request('/api/v1/account', { token: first.accessToken }), 401, 'TOKEN_REVOKED');

    const replacement = authResult(await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: relogin.refreshToken, deviceId },
    }));
    const pending = await request(`/api/v1/sessions/${sessionId}/ws-ticket`, {
      method: 'POST',
      token: replacement.accessToken,
      body: { deviceId, afterSeq: 0 },
    });
    assert.equal(pending.status, 200, pending.text);
    let reuseRevocation: string | undefined;
    getRealtimeHub(db).add({
      audience: 'member',
      sessionId,
      userId: first.user.id,
      authSessionId: reloginPayload.sid,
      ipAddress: '127.0.0.1',
      deliver: () => undefined,
      deliverControl: () => undefined,
      revoke: (reason) => { reuseRevocation = reason; },
      membershipChanged: () => undefined,
      sessionDeleted: () => undefined,
      close: () => undefined,
    });
    db.prepare(`
      UPDATE refresh_tokens
      SET rotated_at = ?, revoked_at = ?
      WHERE token_hash = ?
    `).run(
      new Date(Date.now() - 11_000).toISOString(),
      new Date(Date.now() - 11_000).toISOString(),
      createHash('sha256').update(relogin.refreshToken).digest('hex'),
    );
    assertError(await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: relogin.refreshToken, deviceId },
    }), 401, 'REFRESH_TOKEN_INVALID');
    assert.equal(reuseRevocation, 'REFRESH_TOKEN_REUSE');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM ws_tickets WHERE user_id = ?').pluck().get(first.user.id),
      0,
    );
    assertError(
      await request('/api/v1/account', { token: replacement.accessToken }),
      401,
      'TOKEN_REVOKED',
    );

    const recoveredLogin = authResult(await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'familymember', password: 'Family-password-123!', deviceId },
    }));
    db.prepare(`
      UPDATE refresh_tokens SET expires_at = ? WHERE token_hash = ?
    `).run(
      new Date(Date.now() - 1_000).toISOString(),
      createHash('sha256').update(relogin.refreshToken).digest('hex'),
    );
    assertError(await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: relogin.refreshToken, deviceId },
    }), 401, 'REFRESH_TOKEN_INVALID');
    assert.equal(
      (await request('/api/v1/account', { token: recoveredLogin.accessToken })).status,
      200,
      'an expired historical rotation credential must not revoke a current login',
    );
  });

  test('legacy short and whitespace credentials remain usable for login and password migration', async () => {
    const userId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, 'user', ?, ?)
    `).run(userId, ' x ', bcrypt.hashSync('p', 10), now, now);

    const legacy = authResult(await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: ' x ', password: 'p' },
    }));
    const webLegacy = await request('/api/v1/web-auth/login', {
      method: 'POST',
      body: { username: ' x ', password: 'p' },
    });
    assert.equal(webLegacy.status, 200, webLegacy.text);

    const changed = await request('/api/v1/account/password', {
      method: 'PATCH',
      token: legacy.accessToken,
      body: { currentPassword: 'p', newPassword: 'Legacy-new-password-123!' },
    });
    assert.equal(changed.status, 200, changed.text);
    assertError(await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: ' x ', password: 'p' },
    }), 401, 'INVALID_CREDENTIALS');
  });

  test('member session and Log pages are deterministic, paginated and object-authorized', async () => {
    const now = new Date().toISOString();
    const insertSession = db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at
      ) VALUES (?, ?, 'active', ?, 1, 0, 0, ?, ?)
    `);
    insertSession.run('member-session', 'Member Net', member.user.id, now, now);
    insertSession.run('outsider-session', 'Private Outside Net', outsider.user.id, now, now);
    const insertMembership = db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
    `);
    insertMembership.run(randomUUID(), 'member-session', member.user.id, 'owner', now, now);
    insertMembership.run(randomUUID(), 'member-session', viewer.user.id, 'viewer', now, now);
    insertMembership.run(randomUUID(), 'outsider-session', outsider.user.id, 'owner', now, now);
    const insertLog = db.prepare(`
      INSERT INTO logs (
        sync_id, session_id, controller, callsign, time, rst_sent, rst_rcvd,
        version, created_at, updated_at, created_by, updated_by, deleted_at
      ) VALUES (?, 'member-session', 'BA0CTRL', ?, ?, '59', '58', 1, ?, ?, ?, ?, ?)
    `);
    insertLog.run('member-log-1', 'BA1ONE', '2026-07-13T01:00:00.000Z', now, now, member.user.id, member.user.id, null);
    insertLog.run('member-log-2', 'BA2TWO', '2026-07-13T02:00:00.000Z', now, now, member.user.id, member.user.id, null);
    insertLog.run('member-log-deleted', 'BA3OLD', '2026-07-13T03:00:00.000Z', now, now, member.user.id, member.user.id, now);

    const catalog = await request('/api/v1/sessions/catalog?page=1&pageSize=1&q=Member', {
      token: member.accessToken,
    });
    assert.equal(catalog.status, 200, catalog.text);
    assert.equal(catalog.body.total, 1);
    assert.equal(catalog.body.items[0].sessionId, 'member-session');
    assert.equal(catalog.text.includes('Private Outside Net'), false);

    const page = await request(
      '/api/v1/sessions/member-session/logs?page=1&pageSize=1&sort=timeAsc',
      { token: viewer.accessToken },
    );
    assert.equal(page.status, 200, page.text);
    assert.equal(page.body.total, 2);
    assert.equal(page.body.totalPages, 2);
    assert.equal(page.body.items[0].syncId, 'member-log-1');

    const withDeleted = await request(
      '/api/v1/sessions/member-session/logs?includeDeleted=true&q=BA3OLD',
      { token: viewer.accessToken },
    );
    assert.equal(withDeleted.status, 200, withDeleted.text);
    assert.equal(withDeleted.body.total, 1);
    assert.equal(withDeleted.body.items[0].deletedAt, now);

    const forbidden = await request('/api/v1/sessions/member-session/logs', {
      token: outsider.accessToken,
    });
    assertError(forbidden, 404, 'NOT_FOUND');

    const legacyCatalog = await request('/api/v1/sessions', { token: member.accessToken });
    assert.equal(legacyCatalog.status, 200, legacyCatalog.text);
    assert.ok(Array.isArray(legacyCatalog.body));
  });

  test('members can manage only their own username, password and device sessions', async () => {
    const account = await request('/api/v1/account', { token: member.accessToken });
    assert.equal(account.status, 200, account.text);
    assert.equal(account.body.username, 'memberone');
    assert.equal(account.body.mustChangePassword, false);

    const sessions = await request('/api/v1/account/sessions', { token: member.accessToken });
    assert.equal(sessions.status, 200, sessions.text);
    assert.ok(sessions.body.items.some((item: JsonObject) => item.current === true));
    const devices = await request('/api/v1/account/devices', { token: member.accessToken });
    assert.equal(devices.status, 200, devices.text);
    assert.ok(devices.body.items.some((item: JsonObject) => item.current === true && item.id));

    const outsiderSessionId = activeRefreshId(outsider.refreshToken);
    const crossRevoke = await request(`/api/v1/account/sessions/${outsiderSessionId}`, {
      method: 'DELETE',
      token: member.accessToken,
    });
    assertError(crossRevoke, 404, 'DEVICE_SESSION_NOT_FOUND');

    const wrongPassword = await request('/api/v1/account/username', {
      method: 'PATCH',
      token: member.accessToken,
      body: { username: 'memberrenamed', currentPassword: 'Wrong-password-123!' },
    });
    assertError(wrongPassword, 403, 'CURRENT_PASSWORD_INCORRECT');

    const profile = await request('/api/v1/account', {
      method: 'PATCH',
      token: member.accessToken,
      body: { username: 'memberprofile', currentPassword: 'Member-password-123!' },
    });
    assert.equal(profile.status, 200, profile.text);
    assert.equal(profile.body.user.username, 'memberprofile');

    const renamed = await request('/api/v1/account/username', {
      method: 'PATCH',
      token: member.accessToken,
      body: { username: 'memberrenamed', currentPassword: 'Member-password-123!' },
    });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.body.username, 'memberrenamed');

    const changed = await request('/api/v1/account/password', {
      method: 'PATCH',
      token: member.accessToken,
      body: {
        currentPassword: 'Member-password-123!',
        newPassword: 'Member-new-password-456!',
      },
    });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changed.body.reauthenticationRequired, true);
    assert.ok(Number(changed.body.revokedDeviceSessionCount) >= 1);

    assertError(
      await request('/api/v1/account', { token: member.accessToken }),
      401,
      'TOKEN_REVOKED',
    );
    assertError(await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: member.refreshToken },
    }), 401, 'REFRESH_TOKEN_INVALID');
    assertError(await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'memberrenamed', password: 'Member-password-123!' },
    }), 401, 'INVALID_CREDENTIALS');

    member = authResult(await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'memberrenamed', password: 'Member-new-password-456!' },
    }));
  });

  test('temporary passwords grant only a one-use short-lived password-change credential', async () => {
    const forced = await register('forcedmember', 'Initial-password-123!');
    const temporaryPassword = 'Temporary-password-789!';
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = 1,
            auth_version = auth_version + 1, password_changed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(bcrypt.hashSync(temporaryPassword, 10), now, now, forced.user.id);
      db.prepare(`
        UPDATE refresh_tokens SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL
      `).run(now, forced.user.id);
    }).immediate();

    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'forcedmember', password: temporaryPassword },
    });
    const error = assertError(login, 403, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal(typeof error.details.passwordChangeToken, 'string');
    assert.equal(error.details.passwordChangeTokenExpiresIn, 300);
    assert.equal('accessToken' in error.details, false);

    const unchanged = await request('/api/v1/auth/complete-password-change', {
      method: 'POST',
      body: {
        passwordChangeToken: error.details.passwordChangeToken,
        newPassword: temporaryPassword,
      },
    });
    assertError(unchanged, 409, 'PASSWORD_UNCHANGED');

    const completed = authResult(await request('/api/v1/auth/complete-password-change', {
      method: 'POST',
      body: {
        passwordChangeToken: error.details.passwordChangeToken,
        newPassword: 'Forced-new-password-456!',
      },
    }));
    assert.equal(completed.user.id, forced.user.id);
    assertError(await request('/api/v1/auth/complete-password-change', {
      method: 'POST',
      body: {
        passwordChangeToken: error.details.passwordChangeToken,
        newPassword: 'Another-new-password-456!',
      },
    }), 401, 'PASSWORD_CHANGE_TOKEN_INVALID');

    const disabledAt = new Date().toISOString();
    db.prepare(`
      UPDATE users SET disabled_at = ?, auth_version = auth_version + 1 WHERE id = ?
    `).run(disabledAt, forced.user.id);
    assertError(await request('/api/v1/account', { token: completed.accessToken }), 403, 'ACCOUNT_DISABLED');
    assertError(await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'forcedmember', password: 'Forced-new-password-456!' },
    }), 403, 'ACCOUNT_DISABLED');
  });
});
