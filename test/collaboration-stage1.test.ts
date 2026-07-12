import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';

type JsonObject = Record<string, unknown>;

interface Statement {
  all(...params: unknown[]): JsonObject[];
  get(...params: unknown[]): JsonObject | undefined;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  prepare(sql: string): Statement;
}

interface DatabaseModule {
  openDatabase(path: string): SqliteDatabase | Promise<SqliteDatabase>;
}

interface AppModule {
  createApp(options: {
    db: SqliteDatabase;
    config: Record<string, unknown>;
  }): RequestListener | { app: RequestListener } | Promise<RequestListener | { app: RequestListener }>;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
  requestId: string;
}

interface Actor {
  id: string;
  username: string;
  accessToken: string;
  refreshToken: string;
}

interface InviteSecret {
  inviteId: string;
  code: string;
}

const config = {
  jwtSecret: 'stage1-test-jwt-secret-833ed0cf-493f-4274-a980-22a7daf71fcc',
  jwtIssuer: 'openlogtool-stage1-test',
  bootstrapSecret: 'stage1-test-bootstrap-secret-138a8247-8d11-4211-b82e-f272d9b37176',
  inviteHmacKey: 'stage1-test-invite-hmac-key-e2327df2-0769-419f-96ef-ac0fc2903984',
  publicShareHmacKey: 'stage1-test-public-share-key-8e24bb4e-2a58-4397-b392',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

function moduleExports<T extends object>(namespace: Record<string, unknown>): T {
  const defaultExport = namespace.default;
  return {
    ...(defaultExport && typeof defaultExport === 'object' ? defaultExport : {}),
    ...namespace,
  } as T;
}

async function loadDatabaseModule(): Promise<DatabaseModule> {
  const loaded = moduleExports<DatabaseModule>(
    await import(pathToFileURL(resolve('src/db/database.ts')).href),
  );
  assert.equal(typeof loaded.openDatabase, 'function');
  return loaded;
}

async function loadAppModule(): Promise<AppModule> {
  const loaded = moduleExports<AppModule>(
    await import(pathToFileURL(resolve('src/app.ts')).href),
  );
  assert.equal(typeof loaded.createApp, 'function');
  return loaded;
}

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function objectFrom(value: unknown, nestedKey: string): JsonObject {
  assertObject(value, 'response');
  const nested = value[nestedKey];
  if (nested !== undefined) {
    assertObject(nested, `response.${nestedKey}`);
    return nested;
  }
  return value;
}

function arrayFrom(value: unknown, nestedKey: string): JsonObject[] {
  if (Array.isArray(value)) return value as JsonObject[];
  assertObject(value, 'response');
  assert.ok(Array.isArray(value[nestedKey]), `response.${nestedKey} must be an array`);
  return value[nestedKey] as JsonObject[];
}

function authResult(value: unknown, expectedRole: 'admin' | 'user'): Actor {
  assertObject(value, 'auth response');
  assertObject(value.user, 'auth response.user');
  assert.equal(value.user.role, expectedRole);
  assert.equal(typeof value.accessToken, 'string');
  assert.equal(typeof value.refreshToken, 'string');
  return {
    id: String(value.user.id),
    username: String(value.user.username),
    accessToken: String(value.accessToken),
    refreshToken: String(value.refreshToken),
  };
}

function errorCode(result: HttpResult, expectedStatus: number | number[], expectedCode: string): void {
  const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  assert.ok(statuses.includes(result.status), `expected ${statuses.join('/')} but got ${result.status}: ${result.text}`);
  assertObject(result.body, 'error response');
  assertObject(result.body.error, 'error response.error');
  assert.equal(result.body.error.code, expectedCode, result.text);
  assert.equal(result.body.error.requestId, result.requestId);
}

function assertSuccess(result: HttpResult, statuses: number[] = [200, 201]): JsonObject {
  assert.ok(statuses.includes(result.status), `expected ${statuses.join('/')} but got ${result.status}: ${result.text}`);
  assertObject(result.body, 'success response');
  return result.body;
}

describe('collaboration stage 1', { concurrency: false }, () => {
  let directory: string;
  let db: SqliteDatabase;
  let server: Server;
  let baseUrl: string;

  const actors = new Map<string, Actor>();
  let mainSessionId = '';
  let mainLog: JsonObject;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-stage1-'));
    const databaseModule = await loadDatabaseModule();
    db = await databaseModule.openDatabase(join(directory, 'stage1.db'));

    const appModule = await loadAppModule();
    const created = await appModule.createApp({ db, config });
    const app =
      typeof created === 'function'
        ? created
        : created && typeof created === 'object' && 'app' in created
          ? created.app
          : undefined;
    assert.equal(typeof app, 'function', 'createApp must return an Express app or { app }');

    server = createServer(app);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const adminResponse = await request('/api/v1/auth/bootstrap', {
      method: 'POST',
      headers: { 'x-bootstrap-secret': String(config.bootstrapSecret) },
      body: { username: 'stage1-admin', password: 'Admin-password-123!' },
    });
    assert.equal(adminResponse.status, 201, adminResponse.text);
    actors.set('admin', authResult(adminResponse.body, 'admin'));

    for (const name of [
      'owner',
      'editor',
      'viewer',
      'outsider',
      'expired-user',
      'revoked-user',
      'race-a',
      'race-b',
    ]) {
      const response = await request('/api/v1/auth/register', {
        method: 'POST',
        body: { username: `stage1-${name}`, password: 'User-password-123!' },
      });
      assert.equal(response.status, 201, response.text);
      actors.set(name, authResult(response.body, 'user'));
    }
  });

  after(async () => {
    if (server?.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
    db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function request(
    path: string,
    options: {
      method?: string;
      token?: string;
      idempotencyKey?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<HttpResult> {
    const requestId = randomUUID();
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': requestId,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, headers: response.headers, body, text, requestId };
  }

  function actor(name: string): Actor {
    const value = actors.get(name);
    assert.ok(value, `missing actor: ${name}`);
    return value;
  }

  async function createInitializingSession(
    owner: Actor,
    sessionId = randomUUID(),
    title = 'Stage 1 session',
  ): Promise<string> {
    const response = await request(`/api/v1/sessions/${sessionId}`, {
      method: 'PUT',
      token: owner.accessToken,
      idempotencyKey: randomUUID(),
      body: { title },
    });
    const session = objectFrom(assertSuccess(response), 'session');
    assert.equal(session.sessionId, sessionId);
    assert.equal(session.status, 'initializing');
    assert.equal(session.role, 'owner');
    return sessionId;
  }

  async function uploadBootstrapLogs(owner: Actor, sessionId: string, items: JsonObject[]): Promise<void> {
    const response = await request(`/api/v1/sessions/${sessionId}/bootstrap/logs`, {
      method: 'POST',
      token: owner.accessToken,
      idempotencyKey: randomUUID(),
      body: { items },
    });
    assertSuccess(response);
  }

  async function activateSession(owner: Actor, sessionId: string, expectedLogCount: number): Promise<JsonObject> {
    const response = await request(`/api/v1/sessions/${sessionId}/activate`, {
      method: 'POST',
      token: owner.accessToken,
      idempotencyKey: randomUUID(),
      body: { expectedLogCount },
    });
    const body = assertSuccess(response);
    assert.equal(typeof body.highWatermarkSeq, 'number');
    return body;
  }

  async function snapshot(reader: Actor, sessionId: string): Promise<JsonObject> {
    const response = await request(`/api/v1/sessions/${sessionId}/snapshot`, {
      token: reader.accessToken,
    });
    const body = assertSuccess(response, [200]);
    assert.equal(
      response.headers.get('content-encoding'),
      'gzip',
      'large collaboration snapshots must be compressed',
    );
    assert.equal(body.protocolVersion, 1);
    assertObject(body.session, 'snapshot.session');
    assert.ok(Array.isArray(body.logs), 'snapshot.logs must be an array');
    assert.equal(typeof body.highWatermarkSeq, 'number');
    return body;
  }

  async function createInvite(
    owner: Actor,
    sessionId: string,
    role: 'editor' | 'viewer',
    options: { expiresInHours?: number; maxUses?: number } = {},
  ): Promise<InviteSecret> {
    const response = await request(`/api/v1/sessions/${sessionId}/invites`, {
      method: 'POST',
      token: owner.accessToken,
      idempotencyKey: randomUUID(),
      body: {
        role,
        expiresInHours: options.expiresInHours ?? 24,
        maxUses: options.maxUses ?? 1,
      },
    });
    const invite = objectFrom(assertSuccess(response), 'invite');
    const inviteId = String(invite.inviteId ?? invite.id ?? '');
    const code = String(invite.code ?? '');
    assert.match(inviteId, /^[0-9a-f-]{36}$/i);
    assert.ok(code.length >= 10, 'invite creation must reveal the code exactly once');
    return { inviteId, code };
  }

  async function redeemInvite(
    joining: Actor,
    code: string,
    joinRequestId = randomUUID(),
  ): Promise<HttpResult> {
    return request('/api/v1/collaboration-invites/redeem', {
      method: 'POST',
      token: joining.accessToken,
      idempotencyKey: joinRequestId,
      body: {
        code,
        linkToken: null,
        joinRequestId,
        deviceId: joinRequestId,
      },
    });
  }

  async function publishEmptySession(owner: Actor, title: string): Promise<string> {
    const sessionId = await createInitializingSession(owner, randomUUID(), title);
    await activateSession(owner, sessionId, 0);
    return sessionId;
  }

  test('owner creates one idempotent initializing session and another account cannot claim its id', async () => {
    const owner = actor('owner');
    const sessionId = randomUUID();
    const operationId = randomUUID();

    const missingKey = await request(`/api/v1/sessions/${sessionId}`, {
      method: 'PUT',
      token: owner.accessToken,
      body: { title: '晚点名' },
    });
    errorCode(missingKey, 400, 'IDEMPOTENCY_KEY_REQUIRED');

    const first = await request(`/api/v1/sessions/${sessionId}`, {
      method: 'PUT',
      token: owner.accessToken,
      idempotencyKey: operationId,
      body: { title: '晚点名' },
    });
    const firstSession = objectFrom(assertSuccess(first), 'session');
    assert.equal(firstSession.sessionId, sessionId);
    assert.equal(firstSession.status, 'initializing');
    assert.equal(firstSession.role, 'owner');

    const retry = await request(`/api/v1/sessions/${sessionId}`, {
      method: 'PUT',
      token: owner.accessToken,
      idempotencyKey: operationId,
      body: { title: '晚点名' },
    });
    const retrySession = objectFrom(assertSuccess(retry), 'session');
    assert.deepEqual(retrySession, firstSession, 'idempotent retry must return the original canonical session');

    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions WHERE id = ?) AS sessions_count,
        (SELECT COUNT(*) FROM session_members WHERE session_id = ? AND role = 'owner' AND removed_at IS NULL) AS owners_count
    `).get(sessionId, sessionId);
    assert.equal(Number(counts?.sessions_count), 1);
    assert.equal(Number(counts?.owners_count), 1);

    const hijack = await request(`/api/v1/sessions/${sessionId}`, {
      method: 'PUT',
      token: actor('outsider').accessToken,
      idempotencyKey: randomUUID(),
      body: { title: 'hijack' },
    });
    errorCode(hijack, 409, 'SESSION_ID_UNAVAILABLE');

    const deletedSessionId = await createInitializingSession(
      owner,
      randomUUID(),
      'Deleted session',
    );
    db.prepare(`
      UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), new Date().toISOString(), deletedSessionId);
    const recreateDeleted = await request(`/api/v1/sessions/${deletedSessionId}`, {
      method: 'PUT',
      token: owner.accessToken,
      idempotencyKey: randomUUID(),
      body: { title: 'Deleted session' },
    });
    errorCode(recreateDeleted, 410, 'SESSION_DELETED');

    mainSessionId = sessionId;
  });

  test('bootstrap batches preserve every camelCase field, retry without duplicates, then activate exactly', async () => {
    assert.ok(mainSessionId, 'previous session setup must succeed');
    const owner = actor('owner');
    mainLog = {
      syncId: randomUUID(),
      time: '2026-07-11T07:58:00Z',
      controller: 'BG5CRL',
      callsign: 'BA4AAA',
      rstSent: '59',
      rstRcvd: '57',
      qth: '上海',
      device: 'IC-705',
      power: '10W',
      antenna: 'DP',
      height: '8m',
      remarks: `  ${'移动台'.repeat(500)}  `,
    };
    const batchId = randomUUID();
    const body = { items: [mainLog] };

    const first = await request(`/api/v1/sessions/${mainSessionId}/bootstrap/logs`, {
      method: 'POST',
      token: owner.accessToken,
      idempotencyKey: batchId,
      body,
    });
    assertSuccess(first);
    const retry = await request(`/api/v1/sessions/${mainSessionId}/bootstrap/logs`, {
      method: 'POST',
      token: owner.accessToken,
      idempotencyKey: batchId,
      body,
    });
    assertSuccess(retry);

    const storedCount = db
      .prepare('SELECT COUNT(*) AS count FROM logs WHERE session_id = ? AND sync_id = ?')
      .get(mainSessionId, mainLog.syncId);
    assert.equal(Number(storedCount?.count), 1, 'retrying a bootstrap batch must not duplicate a log');

    const mismatch = await request(`/api/v1/sessions/${mainSessionId}/bootstrap/logs`, {
      method: 'POST',
      token: owner.accessToken,
      idempotencyKey: randomUUID(),
      body: { items: [{ ...mainLog, remarks: 'different content' }] },
    });
    errorCode(mismatch, 409, 'BOOTSTRAP_ENTITY_MISMATCH');

    const wrongCount = await request(`/api/v1/sessions/${mainSessionId}/activate`, {
      method: 'POST',
      token: owner.accessToken,
      idempotencyKey: randomUUID(),
      body: { expectedLogCount: 2 },
    });
    errorCode(wrongCount, 409, 'LOG_COUNT_MISMATCH');

    await activateSession(owner, mainSessionId, 1);

    const afterActivation = await request(`/api/v1/sessions/${mainSessionId}/bootstrap/logs`, {
      method: 'POST',
      token: owner.accessToken,
      idempotencyKey: randomUUID(),
      body,
    });
    errorCode(afterActivation, 409, 'SESSION_NOT_INITIALIZING');

    const ownerSnapshot = await snapshot(owner, mainSessionId);
    assert.equal((ownerSnapshot.session as JsonObject).sessionId, mainSessionId);
    assert.equal((ownerSnapshot.session as JsonObject).status, 'active');
    assert.equal((ownerSnapshot.session as JsonObject).role, 'owner');
    const logs = ownerSnapshot.logs as JsonObject[];
    assert.equal(logs.length, 1);
    for (const [field, expected] of Object.entries(mainLog)) {
      assert.equal(logs[0][field], expected, `snapshot must preserve log.${field}`);
    }
    assert.equal('sync_id' in logs[0], false);
    assert.equal('rst_sent' in logs[0], false);
    assert.equal('rst_rcvd' in logs[0], false);
  });

  test('owner creates an editor invite; redeem joins the same session and snapshot', async () => {
    assert.ok(mainSessionId, 'stage1 Session publish prerequisite failed');
    const invite = await createInvite(actor('owner'), mainSessionId, 'editor');
    const joinRequestId = randomUUID();
    const redeem = await redeemInvite(actor('editor'), invite.code, joinRequestId);
    const joined = assertSuccess(redeem);
    const membership = objectFrom(joined.membership ?? joined, 'membership');
    assert.equal(membership.sessionId, mainSessionId);
    assert.equal(membership.role, 'editor');

    const retry = await redeemInvite(actor('editor'), invite.code, joinRequestId);
    const retried = assertSuccess(retry);
    assert.deepEqual(retried, joined, 'redeeming with the same joinRequestId must be idempotent');

    const editorSnapshot = await snapshot(actor('editor'), mainSessionId);
    assert.equal((editorSnapshot.session as JsonObject).sessionId, mainSessionId);
    assert.equal((editorSnapshot.session as JsonObject).role, 'editor');
    const log = (editorSnapshot.logs as JsonObject[])[0];
    assert.equal(log.syncId, mainLog.syncId);
    assert.equal(log.rstSent, mainLog.rstSent);
    assert.equal(log.rstRcvd, mainLog.rstRcvd);
    assert.equal(log.remarks, mainLog.remarks);
  });

  test('owner/editor/viewer permissions are object-scoped and global admin cannot bypass IDOR', async () => {
    assert.ok(mainSessionId, 'stage1 Session publish prerequisite failed');
    const viewerInvite = await createInvite(actor('owner'), mainSessionId, 'viewer');
    const viewerRedeem = await redeemInvite(actor('viewer'), viewerInvite.code);
    assertSuccess(viewerRedeem);
    const viewerSnapshot = await snapshot(actor('viewer'), mainSessionId);
    assert.equal((viewerSnapshot.session as JsonObject).role, 'viewer');

    const ownerMembers = await request(`/api/v1/sessions/${mainSessionId}/members`, {
      token: actor('owner').accessToken,
    });
    const members = arrayFrom(assertSuccess(ownerMembers, [200]), 'members');
    assert.equal(members.filter((member) => member.removedAt == null).length, 3);

    for (const name of ['editor', 'viewer']) {
      const listMembers = await request(`/api/v1/sessions/${mainSessionId}/members`, {
        token: actor(name).accessToken,
      });
      errorCode(listMembers, 403, 'FORBIDDEN');

      const createForbiddenInvite = await request(`/api/v1/sessions/${mainSessionId}/invites`, {
        method: 'POST',
        token: actor(name).accessToken,
        idempotencyKey: randomUUID(),
        body: { role: 'viewer', expiresInHours: 24, maxUses: 1 },
      });
      errorCode(createForbiddenInvite, 403, 'FORBIDDEN');
    }

    for (const name of ['outsider', 'admin']) {
      const hiddenSnapshot = await request(`/api/v1/sessions/${mainSessionId}/snapshot`, {
        token: actor(name).accessToken,
      });
      errorCode(hiddenSnapshot, 404, 'NOT_FOUND');
    }

    const outsidersSession = await publishEmptySession(actor('outsider'), 'Outsider private session');
    const ownerCrossRead = await request(`/api/v1/sessions/${outsidersSession}/snapshot`, {
      token: actor('owner').accessToken,
    });
    errorCode(ownerCrossRead, 404, 'NOT_FOUND');
  });

  test('expired and revoked invites fail uniformly; a one-use invite has one concurrent winner', async () => {
    assert.ok(mainSessionId, 'stage1 Session publish prerequisite failed');
    const owner = actor('owner');

    const expired = await createInvite(owner, mainSessionId, 'viewer');
    db.prepare('UPDATE collaboration_invites SET expires_at = ? WHERE id = ?').run(
      '2000-01-01T00:00:00.000Z',
      expired.inviteId,
    );
    const expiredRedeem = await redeemInvite(actor('expired-user'), expired.code);
    errorCode(expiredRedeem, [400, 404, 410], 'INVITE_INVALID');

    const revoked = await createInvite(owner, mainSessionId, 'viewer');
    const revoke = await request(`/api/v1/sessions/${mainSessionId}/invites/${revoked.inviteId}`, {
      method: 'DELETE',
      token: owner.accessToken,
      idempotencyKey: randomUUID(),
    });
    assert.ok([200, 204].includes(revoke.status), revoke.text);
    const revokedRedeem = await redeemInvite(actor('revoked-user'), revoked.code);
    errorCode(revokedRedeem, [400, 404, 410], 'INVITE_INVALID');

    const once = await createInvite(owner, mainSessionId, 'viewer', { maxUses: 1 });
    const [left, right] = await Promise.all([
      redeemInvite(actor('race-a'), once.code),
      redeemInvite(actor('race-b'), once.code),
    ]);
    const winners = [left, right].filter((result) => [200, 201].includes(result.status));
    const losers = [left, right].filter((result) => ![200, 201].includes(result.status));
    assert.equal(winners.length, 1, `exactly one concurrent redeem must succeed: ${left.status}/${right.status}`);
    assert.equal(losers.length, 1);
    errorCode(losers[0], [400, 404, 409, 410], 'INVITE_INVALID');

    const usage = db
      .prepare('SELECT used_count, max_uses FROM collaboration_invites WHERE id = ?')
      .get(once.inviteId);
    assert.equal(Number(usage?.used_count), 1);
    assert.equal(Number(usage?.max_uses), 1);
  });

  test('member removal takes effect immediately and ownership remains singular and transferable', async () => {
    assert.ok(mainSessionId, 'stage1 Session publish prerequisite failed');
    const owner = actor('owner');
    const editor = actor('editor');
    const viewer = actor('viewer');

    const removeEditor = await request(
      `/api/v1/sessions/${mainSessionId}/members/${editor.id}`,
      {
        method: 'DELETE',
        token: owner.accessToken,
        idempotencyKey: randomUUID(),
      },
    );
    assert.ok([200, 204].includes(removeEditor.status), removeEditor.text);

    const removedEditorSnapshot = await request(`/api/v1/sessions/${mainSessionId}/snapshot`, {
      token: editor.accessToken,
    });
    errorCode(removedEditorSnapshot, 403, 'MEMBERSHIP_REVOKED');

    const removeOwner = await request(
      `/api/v1/sessions/${mainSessionId}/members/${owner.id}`,
      {
        method: 'DELETE',
        token: owner.accessToken,
        idempotencyKey: randomUUID(),
      },
    );
    errorCode(removeOwner, 409, 'OWNER_TRANSFER_REQUIRED');

    const transfer = await request(`/api/v1/sessions/${mainSessionId}/transfer-ownership`, {
      method: 'POST',
      token: owner.accessToken,
      idempotencyKey: randomUUID(),
      body: { newOwnerUserId: viewer.id },
    });
    assertSuccess(transfer);

    const ownerMembership = await request(`/api/v1/sessions/${mainSessionId}/membership`, {
      token: owner.accessToken,
    });
    const oldOwner = objectFrom(assertSuccess(ownerMembership, [200]), 'membership');
    assert.equal(oldOwner.role, 'editor');

    const viewerMembership = await request(`/api/v1/sessions/${mainSessionId}/membership`, {
      token: viewer.accessToken,
    });
    const newOwner = objectFrom(assertSuccess(viewerMembership, [200]), 'membership');
    assert.equal(newOwner.role, 'owner');

    const ownership = db.prepare(`
      SELECT
        s.owner_user_id AS session_owner,
        SUM(CASE WHEN sm.role = 'owner' AND sm.removed_at IS NULL THEN 1 ELSE 0 END) AS owner_count
      FROM sessions s
      JOIN session_members sm ON sm.session_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
    `).get(mainSessionId);
    assert.equal(ownership?.session_owner, viewer.id);
    assert.equal(Number(ownership?.owner_count), 1);

    const oldOwnerCannotManage = await request(`/api/v1/sessions/${mainSessionId}/invites`, {
      method: 'POST',
      token: owner.accessToken,
      idempotencyKey: randomUUID(),
      body: { role: 'viewer', expiresInHours: 24, maxUses: 1 },
    });
    errorCode(oldOwnerCannotManage, 403, 'FORBIDDEN');
  });
});
