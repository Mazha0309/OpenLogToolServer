import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { createApp } from '../src/app';
import { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';
import {
  CollaborationWsController,
  createCollaborationWsServer,
} from '../src/ws';

type JsonObject = Record<string, unknown>;

interface Actor {
  id: string;
  accessToken: string;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: JsonObject;
  text: string;
}

interface SessionState {
  version: number;
  event_seq: number;
  status: string;
  updated_at: string;
  deleted_at: string | null;
}

const deviceId = 'a5203bb6-c5c7-47bb-a7b7-b5c2623ee504';

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function success(result: HttpResult, expected = 200): JsonObject {
  assert.equal(result.status, expected, result.text);
  return result.body;
}

function assertError(result: HttpResult, status: number, code: string): JsonObject {
  assert.equal(result.status, status, result.text);
  assertObject(result.body.error, 'error');
  assert.equal(result.body.error.code, code, result.text);
  return result.body.error;
}

function authActor(body: JsonObject): Actor {
  assertObject(body.user, 'user');
  assert.equal(typeof body.accessToken, 'string');
  return { id: String(body.user.id), accessToken: String(body.accessToken) };
}

function firstResult(body: JsonObject): JsonObject {
  assert.ok(Array.isArray(body.results), 'mutation response.results must be an array');
  assert.equal(body.results.length, 1);
  assertObject(body.results[0], 'mutation response.results[0]');
  return body.results[0];
}

class WsInbox {
  readonly messages: JsonObject[] = [];
  private readonly waiters: Array<(message: JsonObject) => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as JsonObject;
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed);
      else this.messages.push(parsed);
    });
  }

  async next(): Promise<JsonObject> {
    const queued = this.messages.shift();
    if (queued) return queued;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for WebSocket message')),
        3_000,
      );
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
}

describe('collaboration Session deletion', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let wsController: CollaborationWsController;
  let baseUrl: string;
  let wsBaseUrl: string;
  const actors = new Map<string, Actor>();

  const config: AppConfig = {
    port: 0,
    dbPath: ':memory:',
    jwtSecret: 'session-delete-test-jwt-secret-bba8451c-7be0-434a-ad89-bae29bb0e845',
    jwtIssuer: 'openlogtool-session-delete-test',
    bootstrapSecret: 'session-delete-bootstrap-secret-6267871d-c7b2-4bc7-87eb-447339402fa5',
    inviteHmacKey: 'session-delete-invite-hmac-key-74fc57db-cff8-44c1-881d-81bc395d6948',
    accessTokenTtlSeconds: 300,
    refreshTokenTtlSeconds: 3_600,
    corsOrigins: [],
    trustProxy: false,
    jsonBodyLimit: '1mb',
    rateLimitEnabled: false,
    environment: 'test',
  };

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-session-delete-'));
    config.dbPath = join(directory, 'session-delete.db');
    db = openDatabase(config.dbPath);
    server = createServer(createApp({ db, config }));
    wsController = createCollaborationWsServer(server, { db, config });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;

    actors.set(
      'admin',
      authActor(
        success(
          await request('/api/v1/auth/bootstrap', {
            method: 'POST',
            headers: { 'x-bootstrap-secret': config.bootstrapSecret },
            body: { username: 'delete-admin', password: 'Admin-password-123!' },
          }),
          201,
        ),
      ),
    );
    for (const name of ['owner', 'viewer', 'outsider']) {
      actors.set(
        name,
        authActor(
          success(
            await request('/api/v1/auth/register', {
              method: 'POST',
              body: { username: `delete-${name}`, password: 'User-password-123!' },
            }),
            201,
          ),
        ),
      );
    }
  });

  after(async () => {
    wsController?.close();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function actor(name: string): Actor {
    const value = actors.get(name);
    assert.ok(value, `missing actor ${name}`);
    return value;
  }

  async function request(
    path: string,
    options: {
      method?: string;
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': randomUUID(),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? (JSON.parse(text) as JsonObject) : {},
      text,
    };
  }

  async function createSession(
    options: {
      activate?: boolean;
      title?: string;
      activationMutationId?: string;
    } = {},
  ): Promise<string> {
    const sessionId = randomUUID();
    success(
      await request(`/api/v1/sessions/${sessionId}`, {
        method: 'PUT',
        token: actor('owner').accessToken,
        headers: { 'idempotency-key': randomUUID(), 'x-device-id': deviceId },
        body: { title: options.title ?? 'Session deletion test' },
      }),
      201,
    );
    if (options.activate !== false) {
      success(
        await request(`/api/v1/sessions/${sessionId}/activate`, {
          method: 'POST',
          token: actor('owner').accessToken,
          headers: {
            'idempotency-key': options.activationMutationId ?? randomUUID(),
            'x-device-id': deviceId,
          },
          body: { expectedLogCount: 0 },
        }),
      );
    }
    return sessionId;
  }

  async function mutate(
    sessionId: string,
    name: string,
    operation: JsonObject,
  ): Promise<HttpResult> {
    return request(`/api/v1/sessions/${sessionId}/mutations`, {
      method: 'POST',
      token: actor(name).accessToken,
      body: { protocolVersion: 1, deviceId, operations: [operation] },
    });
  }

  function sessionState(sessionId: string): SessionState {
    const row = db.prepare(`
      SELECT version, event_seq, status, updated_at, deleted_at
      FROM sessions WHERE id = ?
    `).get(sessionId) as SessionState | undefined;
    assert.ok(row, `missing Session ${sessionId}`);
    return row;
  }

  async function closeSession(sessionId: string): Promise<JsonObject> {
    const current = sessionState(sessionId);
    const body = success(
      await mutate(sessionId, 'owner', {
        mutationId: randomUUID(),
        entityType: 'session',
        entityId: sessionId,
        operation: 'close',
        baseVersion: current.version,
      }),
    );
    const result = firstResult(body);
    assert.equal(result.status, 'accepted');
    return result;
  }

  async function createInvite(sessionId: string): Promise<JsonObject> {
    const body = success(
      await request(`/api/v1/sessions/${sessionId}/invites`, {
        method: 'POST',
        token: actor('owner').accessToken,
        headers: { 'idempotency-key': randomUUID() },
        body: { role: 'viewer', maxUses: 1, expiresInHours: 24 },
      }),
      201,
    );
    assertObject(body.invite, 'invite');
    return body.invite;
  }

  async function joinViewer(invite: JsonObject): Promise<void> {
    const joinRequestId = randomUUID();
    success(
      await request('/api/v1/collaboration-invites/redeem', {
        method: 'POST',
        token: actor('viewer').accessToken,
        headers: { 'idempotency-key': joinRequestId },
        body: {
          code: invite.code,
          linkToken: null,
          joinRequestId,
          deviceId,
        },
      }),
      201,
    );
  }

  async function wsTicket(
    sessionId: string,
    afterSeq: number,
    actorName = 'viewer',
  ): Promise<string> {
    const body = success(
      await request(`/api/v1/sessions/${sessionId}/ws-ticket`, {
        method: 'POST',
        token: actor(actorName).accessToken,
        body: { deviceId, afterSeq },
      }),
    );
    assert.equal(typeof body.ticket, 'string');
    return String(body.ticket);
  }

  async function connect(ticket: string): Promise<WsInbox> {
    const ws = new WebSocket(
      `${wsBaseUrl}/ws/collaboration?ticket=${encodeURIComponent(ticket)}`,
    );
    const inbox = new WsInbox(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return inbox;
  }

  async function rejectedConnection(ticket: string, expectedStatus: number): Promise<void> {
    const ws = new WebSocket(
      `${wsBaseUrl}/ws/collaboration?ticket=${encodeURIComponent(ticket)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        try {
          assert.equal(response.statusCode, expectedStatus);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      ws.once('open', () => reject(new Error('WebSocket unexpectedly connected')));
      ws.once('error', () => undefined);
    });
  }

  test('active delete is a durable rejection with zero business or event writes', async () => {
    const sessionId = await createSession({ title: 'Active Session cannot be deleted' });
    const invite = await createInvite(sessionId);
    const before = sessionState(sessionId);
    const mutationId = randomUUID();

    const body = success(
      await mutate(sessionId, 'owner', {
        mutationId,
        entityType: 'session',
        entityId: sessionId,
        operation: 'delete',
        baseVersion: before.version,
      }),
    );
    const result = firstResult(body);
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'SESSION_MUST_BE_CLOSED');
    assert.deepEqual(sessionState(sessionId), before);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM session_events
        WHERE session_id = ? AND type = 'session.deleted'
      `).pluck().get(sessionId),
      0,
    );
    assert.equal(
      db.prepare('SELECT revoked_at FROM collaboration_invites WHERE id = ?').pluck().get(
        invite.inviteId,
      ),
      null,
    );

    const stored = db.prepare(`
      SELECT response_json FROM processed_mutations WHERE mutation_id = ?
    `).get(mutationId) as { response_json: string } | undefined;
    assert.ok(stored, 'the deterministic rejection must remain idempotent');
    assert.deepEqual(JSON.parse(stored.response_json), result);

    const payloadResult = firstResult(
      success(
        await mutate(sessionId, 'owner', {
          mutationId: randomUUID(),
          entityType: 'session',
          entityId: sessionId,
          operation: 'delete',
          baseVersion: before.version,
          patch: { title: 'delete must not accept payload' },
        }),
      ),
    );
    assert.equal(payloadResult.status, 'rejected');
    assert.equal(payloadResult.code, 'VALIDATION_FAILED');
    assert.deepEqual(sessionState(sessionId), before);
  });

  test('an initializing Session can be deleted to cancel an unfinished publication', async () => {
    const sessionId = await createSession({
      activate: false,
      title: 'Cancelled initializing publication',
    });
    const beforeDelete = sessionState(sessionId);
    assert.equal(beforeDelete.status, 'initializing');
    assert.equal(beforeDelete.event_seq, 0);
    const invite = await createInvite(sessionId);
    await joinViewer(invite);

    const bootstrapMutationId = randomUUID();
    const bootstrapBody = {
      items: [
        {
          syncId: randomUUID(),
          time: '2026-07-12T08:00:00.000Z',
          controller: 'BG5CRL',
          callsign: 'BA4INI',
        },
      ],
    };
    const bootstrapped = success(
      await request(`/api/v1/sessions/${sessionId}/bootstrap/logs`, {
        method: 'POST',
        token: actor('owner').accessToken,
        headers: { 'idempotency-key': bootstrapMutationId, 'x-device-id': deviceId },
        body: bootstrapBody,
      }),
    );

    const mutationId = randomUUID();
    const operation = {
      mutationId,
      entityType: 'session',
      entityId: sessionId,
      operation: 'delete',
      baseVersion: beforeDelete.version,
    };
    const deletedBody = success(await mutate(sessionId, 'owner', operation));
    const deletedResult = firstResult(deletedBody);
    assert.equal(deletedResult.status, 'accepted');
    assertObject(deletedResult.event, 'initializing delete event');
    assert.equal(deletedResult.event.type, 'session.deleted');
    assert.equal(deletedResult.event.seq, 1);

    const afterDelete = sessionState(sessionId);
    assert.equal(afterDelete.status, 'initializing');
    assert.equal(afterDelete.version, beforeDelete.version + 1);
    assert.equal(afterDelete.event_seq, 1);
    assert.equal(typeof afterDelete.deleted_at, 'string');
    assert.deepEqual(success(await mutate(sessionId, 'owner', operation)), deletedBody);

    const bootstrapReplay = await request(`/api/v1/sessions/${sessionId}/bootstrap/logs`, {
      method: 'POST',
      token: actor('owner').accessToken,
      headers: { 'idempotency-key': bootstrapMutationId, 'x-device-id': deviceId },
      body: bootstrapBody,
    });
    assert.deepEqual(success(bootstrapReplay), bootstrapped);
    assert.equal(bootstrapReplay.headers.get('idempotent-replay'), 'true');

    const snapshot = await request(`/api/v1/sessions/${sessionId}/snapshot`, {
      token: actor('owner').accessToken,
    });
    const error = assertError(snapshot, 410, 'SESSION_DELETED');
    assertObject(error.details, 'initializing SESSION_DELETED details');
    assert.equal(error.details.finalSeq, 1);

    const viewerEvents = success(
      await request(`/api/v1/sessions/${sessionId}/events?afterSeq=0&limit=10`, {
        token: actor('viewer').accessToken,
      }),
    );
    assert.ok(Array.isArray(viewerEvents.events));
    assert.equal(viewerEvents.events.length, 1);
    assertObject(viewerEvents.events[0], 'initializing delete event for viewer');
    assert.equal(viewerEvents.events[0].type, 'session.deleted');
    const viewerSnapshot = await request(`/api/v1/sessions/${sessionId}/snapshot`, {
      token: actor('viewer').accessToken,
    });
    assertError(viewerSnapshot, 410, 'SESSION_DELETED');
  });

  test('closed delete is final, replayable and visible only to retained members', async () => {
    const activationMutationId = randomUUID();
    const sessionId = await createSession({
      title: 'Closed Session deletion',
      activationMutationId,
    });
    const joiningInvite = await createInvite(sessionId);
    await joinViewer(joiningInvite);
    const pendingInvite = await createInvite(sessionId);
    const closeResult = await closeSession(sessionId);
    assertObject(closeResult.event, 'close event');
    const beforeDelete = sessionState(sessionId);
    const closeSeq = Number(closeResult.event.seq);

    const staleDelete = firstResult(
      success(
        await mutate(sessionId, 'owner', {
          mutationId: randomUUID(),
          entityType: 'session',
          entityId: sessionId,
          operation: 'delete',
          baseVersion: beforeDelete.version - 1,
        }),
      ),
    );
    assert.equal(staleDelete.status, 'conflict');
    assert.equal(staleDelete.code, 'VERSION_CONFLICT');
    assert.deepEqual(sessionState(sessionId), beforeDelete);

    const viewerDelete = firstResult(
      success(
        await mutate(sessionId, 'viewer', {
          mutationId: randomUUID(),
          entityType: 'session',
          entityId: sessionId,
          operation: 'delete',
          baseVersion: beforeDelete.version,
        }),
      ),
    );
    assert.equal(viewerDelete.status, 'rejected');
    assert.equal(viewerDelete.code, 'FORBIDDEN');
    assert.deepEqual(sessionState(sessionId), beforeDelete);
    assertError(
      await mutate(sessionId, 'outsider', {
        mutationId: randomUUID(),
        entityType: 'session',
        entityId: sessionId,
        operation: 'delete',
        baseVersion: beforeDelete.version,
      }),
      404,
      'NOT_FOUND',
    );

    const liveTicket = await wsTicket(sessionId, closeSeq);
    const staleTicket = await wsTicket(sessionId, closeSeq);
    const inbox = await connect(liveTicket);
    assert.equal((await inbox.next()).type, 'hello');
    assert.deepEqual(await inbox.next(), { type: 'ready', cursor: closeSeq });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      inbox.ws.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    const mutationId = randomUUID();
    const operation = {
      mutationId,
      entityType: 'session',
      entityId: sessionId,
      operation: 'delete',
      baseVersion: beforeDelete.version,
    };
    const deletedBody = success(await mutate(sessionId, 'owner', operation));
    const deletedResult = firstResult(deletedBody);
    assert.equal(deletedResult.status, 'accepted');
    assertObject(deletedResult.event, 'delete event');
    assert.equal(deletedResult.event.type, 'session.deleted');
    assert.equal(deletedResult.event.seq, closeSeq + 1);
    assertObject(deletedResult.event.payload, 'delete event payload');
    assert.equal(typeof deletedResult.event.payload.deletedAt, 'string');

    const liveMessage = await inbox.next();
    assert.equal(liveMessage.type, 'event');
    assert.deepEqual(liveMessage.event, deletedResult.event);
    assert.deepEqual(await closed, { code: 1000, reason: 'Session deleted' });

    const afterDelete = sessionState(sessionId);
    assert.equal(afterDelete.status, 'closed');
    assert.equal(afterDelete.version, beforeDelete.version + 1);
    assert.equal(afterDelete.event_seq, beforeDelete.event_seq + 1);
    assert.equal(typeof afterDelete.deleted_at, 'string');
    assert.equal(afterDelete.deleted_at, deletedResult.event.payload.deletedAt);

    const events = db.prepare(`
      SELECT seq, type, mutation_id FROM session_events
      WHERE session_id = ? ORDER BY seq
    `).all(sessionId) as Array<{ seq: number; type: string; mutation_id: string | null }>;
    assert.deepEqual(
      events.map(({ seq, type }) => ({ seq, type })),
      [
        { seq: 1, type: 'session.activated' },
        { seq: 2, type: 'session.closed' },
        { seq: 3, type: 'session.deleted' },
      ],
    );
    assert.equal(events.at(-1)?.mutation_id, mutationId);
    assert.equal(
      events.filter((event) => event.type === 'session.deleted').length,
      1,
      'session.deleted must be the unique final data event',
    );

    const revokedInvite = db.prepare(`
      SELECT revoked_at, revoked_by FROM collaboration_invites WHERE id = ?
    `).get(pendingInvite.inviteId) as { revoked_at: string | null; revoked_by: string | null };
    assert.equal(typeof revokedInvite.revoked_at, 'string');
    assert.equal(revokedInvite.revoked_at, afterDelete.deleted_at);
    assert.equal(revokedInvite.revoked_by, actor('owner').id);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM collaboration_invites
        WHERE session_id = ? AND revoked_at IS NULL
      `).pluck().get(sessionId),
      0,
      'deletion must revoke every invite, including an already redeemed invite',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM ws_tickets WHERE session_id = ?').pluck().get(sessionId),
      0,
      'deletion must invalidate both consumed and unconsumed WebSocket tickets',
    );
    const postDeleteJoinRequestId = randomUUID();
    assertError(
      await request('/api/v1/collaboration-invites/redeem', {
        method: 'POST',
        token: actor('outsider').accessToken,
        headers: { 'idempotency-key': postDeleteJoinRequestId },
        body: {
          code: pendingInvite.code,
          linkToken: null,
          joinRequestId: postDeleteJoinRequestId,
          deviceId,
        },
      }),
      404,
      'INVITE_INVALID',
    );

    const stored = db.prepare(`
      SELECT status_code, response_json FROM processed_mutations WHERE mutation_id = ?
    `).get(mutationId) as { status_code: number; response_json: string } | undefined;
    assert.ok(stored);
    assert.equal(stored.status_code, 200);
    assert.deepEqual(JSON.parse(stored.response_json), deletedResult);

    const replayBody = success(await mutate(sessionId, 'owner', operation));
    assert.deepEqual(replayBody, deletedBody);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM session_events
        WHERE session_id = ? AND type = 'session.deleted'
      `).pluck().get(sessionId),
      1,
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM collaboration_audit_events
        WHERE session_id = ? AND action = 'session.deleted'
      `).pluck().get(sessionId),
      1,
    );

    const storedActivation = db.prepare(`
      SELECT response_json FROM processed_mutations WHERE mutation_id = ?
    `).get(activationMutationId) as { response_json: string };
    const activationReplay = await request(`/api/v1/sessions/${sessionId}/activate`, {
      method: 'POST',
      token: actor('owner').accessToken,
      headers: { 'idempotency-key': activationMutationId, 'x-device-id': deviceId },
      body: { expectedLogCount: 0 },
    });
    assert.deepEqual(success(activationReplay), JSON.parse(storedActivation.response_json));
    assert.equal(activationReplay.headers.get('idempotent-replay'), 'true');

    const rejectedWrite = firstResult(
      success(
        await mutate(sessionId, 'owner', {
          mutationId: randomUUID(),
          entityType: 'session',
          entityId: sessionId,
          operation: 'update',
          baseVersion: afterDelete.version,
          patch: { title: 'must not change after deletion' },
        }),
      ),
    );
    assert.equal(rejectedWrite.status, 'rejected');
    assert.equal(rejectedWrite.code, 'SESSION_DELETED');
    assert.deepEqual(sessionState(sessionId), afterDelete);

    const memberEvents = success(
      await request(`/api/v1/sessions/${sessionId}/events?afterSeq=${closeSeq}&limit=10`, {
        token: actor('viewer').accessToken,
      }),
    );
    assert.equal(memberEvents.toSeq, closeSeq + 1);
    assert.equal(memberEvents.headSeq, closeSeq + 1);
    assert.equal(memberEvents.hasMore, false);
    assert.ok(Array.isArray(memberEvents.events));
    assert.deepEqual(memberEvents.events, [deletedResult.event]);

    const memberSnapshot = await request(`/api/v1/sessions/${sessionId}/snapshot`, {
      token: actor('viewer').accessToken,
    });
    const deletedError = assertError(memberSnapshot, 410, 'SESSION_DELETED');
    assertObject(deletedError.details, 'SESSION_DELETED details');
    assert.equal(deletedError.details.deletedAt, afterDelete.deleted_at);
    assert.equal(deletedError.details.finalSeq, closeSeq + 1);
    assert.equal('logs' in memberSnapshot.body, false);
    assert.equal(JSON.stringify(memberSnapshot.body).includes('"logs"'), false);

    assertError(
      await request(`/api/v1/sessions/${sessionId}/events?afterSeq=${closeSeq}`, {
        token: actor('outsider').accessToken,
      }),
      404,
      'NOT_FOUND',
    );
    assertError(
      await request(`/api/v1/sessions/${sessionId}/snapshot`, {
        token: actor('outsider').accessToken,
      }),
      404,
      'NOT_FOUND',
    );
    await rejectedConnection(staleTicket, 401);
  });

  test('concurrent delete commands produce exactly one terminal event', async () => {
    const sessionId = await createSession({ title: 'Concurrent Session deletion' });
    await closeSession(sessionId);
    const beforeDelete = sessionState(sessionId);
    const operations = [randomUUID(), randomUUID()].map((mutationId) => ({
      mutationId,
      entityType: 'session',
      entityId: sessionId,
      operation: 'delete',
      baseVersion: beforeDelete.version,
    }));

    const responses = await Promise.all(
      operations.map((operation) => mutate(sessionId, 'owner', operation)),
    );
    const results = responses.map((response) => firstResult(success(response)));
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ['accepted', 'rejected'],
    );
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected?.code, 'SESSION_DELETED');
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM session_events
        WHERE session_id = ? AND type = 'session.deleted'
      `).pluck().get(sessionId),
      1,
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM collaboration_audit_events
        WHERE session_id = ? AND action = 'session.deleted'
      `).pluck().get(sessionId),
      1,
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM processed_mutations
        WHERE mutation_id IN (?, ?)
      `).pluck().get(operations[0].mutationId, operations[1].mutationId),
      2,
    );
  });

  test('a failed final-event insert rolls the deletion transaction back completely', async () => {
    const sessionId = await createSession({ title: 'Delete transaction rollback' });
    const invite = await createInvite(sessionId);
    await closeSession(sessionId);
    const beforeDelete = sessionState(sessionId);
    await wsTicket(sessionId, beforeDelete.event_seq, 'owner');
    const ticketsBefore = Number(
      db.prepare('SELECT COUNT(*) FROM ws_tickets WHERE session_id = ?').pluck().get(sessionId),
    );
    assert.equal(ticketsBefore, 1);
    const mutationId = randomUUID();
    const operation = {
      mutationId,
      entityType: 'session',
      entityId: sessionId,
      operation: 'delete',
      baseVersion: beforeDelete.version,
    };
    const triggerName = 'test_fail_session_deleted_event';
    assert.match(mutationId, /^[0-9a-f-]{36}$/);
    db.exec(`
      CREATE TEMP TRIGGER ${triggerName}
      BEFORE INSERT ON session_events
      WHEN NEW.mutation_id = '${mutationId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced session.deleted failure');
      END;
    `);

    const originalConsoleError = console.error;
    console.error = () => undefined;
    let failed: HttpResult;
    try {
      failed = await mutate(sessionId, 'owner', operation);
    } finally {
      console.error = originalConsoleError;
      db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }
    assertError(failed!, 500, 'INTERNAL_ERROR');
    assert.deepEqual(sessionState(sessionId), beforeDelete);
    assert.equal(
      db.prepare('SELECT revoked_at FROM collaboration_invites WHERE id = ?').pluck().get(
        invite.inviteId,
      ),
      null,
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM session_events
        WHERE session_id = ? AND type = 'session.deleted'
      `).pluck().get(sessionId),
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
        mutationId,
      ),
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM ws_tickets WHERE session_id = ?').pluck().get(sessionId),
      ticketsBefore,
      'ticket invalidation must roll back with the deletion transaction',
    );

    const retriedBody = success(await mutate(sessionId, 'owner', operation));
    const retriedResult = firstResult(retriedBody);
    assert.equal(retriedResult.status, 'accepted');
    assertObject(retriedResult.event, 'retried delete event');
    assert.equal(retriedResult.event.type, 'session.deleted');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
        mutationId,
      ),
      1,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM ws_tickets WHERE session_id = ?').pluck().get(sessionId),
      0,
    );
  });

  test('a failed deletion audit insert rolls the entire terminal transaction back', async () => {
    const sessionId = await createSession({ title: 'Delete audit rollback' });
    const invite = await createInvite(sessionId);
    await closeSession(sessionId);
    const beforeDelete = sessionState(sessionId);
    await wsTicket(sessionId, beforeDelete.event_seq, 'owner');
    const ticketsBefore = Number(
      db.prepare('SELECT COUNT(*) FROM ws_tickets WHERE session_id = ?').pluck().get(sessionId),
    );
    assert.equal(ticketsBefore, 1);
    const mutationId = randomUUID();
    const operation = {
      mutationId,
      entityType: 'session',
      entityId: sessionId,
      operation: 'delete',
      baseVersion: beforeDelete.version,
    };
    const triggerName = 'test_fail_session_deleted_audit';
    db.exec(`
      CREATE TEMP TRIGGER ${triggerName}
      BEFORE INSERT ON collaboration_audit_events
      WHEN NEW.action = 'session.deleted' AND NEW.mutation_id = '${mutationId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced session.deleted audit failure');
      END;
    `);

    const originalConsoleError = console.error;
    console.error = () => undefined;
    let failed: HttpResult;
    try {
      failed = await mutate(sessionId, 'owner', operation);
    } finally {
      console.error = originalConsoleError;
      db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }
    assertError(failed!, 500, 'INTERNAL_ERROR');
    assert.deepEqual(sessionState(sessionId), beforeDelete);
    assert.equal(
      db.prepare('SELECT revoked_at FROM collaboration_invites WHERE id = ?').pluck().get(
        invite.inviteId,
      ),
      null,
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM session_events
        WHERE session_id = ? AND type = 'session.deleted'
      `).pluck().get(sessionId),
      0,
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM collaboration_audit_events
        WHERE session_id = ? AND action = 'session.deleted'
      `).pluck().get(sessionId),
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
        mutationId,
      ),
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM ws_tickets WHERE session_id = ?').pluck().get(sessionId),
      ticketsBefore,
      'ticket invalidation must roll back when audit insertion fails',
    );

    const retriedResult = firstResult(success(await mutate(sessionId, 'owner', operation)));
    assert.equal(retriedResult.status, 'accepted');
    assertObject(retriedResult.event, 'retried delete event after audit failure');
    assert.equal(retriedResult.event.type, 'session.deleted');
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM collaboration_audit_events
        WHERE session_id = ? AND action = 'session.deleted' AND mutation_id = ?
      `).pluck().get(sessionId, mutationId),
      1,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
        mutationId,
      ),
      1,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM ws_tickets WHERE session_id = ?').pluck().get(sessionId),
      0,
    );
  });
});
