import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';
import {
  derivePublicShareSecret,
  hashPublicShareSecret,
  hashPublicWsTicket,
} from '../src/collaboration/public';
import {
  createCollaborationWsServer,
  type CollaborationWsController,
} from '../src/ws';

type JsonObject = Record<string, unknown>;

interface Actor {
  id: string;
  role: 'admin' | 'user';
  accessToken: string;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: JsonObject;
  text: string;
}

interface PublicShareSecret {
  publicShareId: string;
  secret: string;
  body: JsonObject;
}

interface PublicAccess {
  accessToken: string;
  expiresAt: string;
}

interface AuditRow {
  id: string;
  action: string;
  actor_user_id: string;
  target_user_id: string | null;
  request_id: string;
  mutation_id: string;
  before_json: string | null;
  after_json: string | null;
  details_json: string;
}

type PublicLiveshareConfig = AppConfig & {
  publicShareHmacKey: string;
  publicAccessTokenTtlSeconds: number;
};

const deviceId = '4394117c-d55e-48e6-96cc-c12a88ef8071';
const passwordSentinel = 'NEVER_EXPOSE_PUBLIC_LIVESHARE_PASSWORD_HASH';
const sourceDeviceSentinel = 'c22f4be8-dcf8-440c-8b43-bad80f8ee9d4';
const publicSnapshotMaxBytes = 8 * 1024 * 1024;
const maxUnconsumedPublicTicketsPerShare = 8;

const publicSnapshotKeys = ['protocolVersion', 'session', 'highWatermarkSeq', 'logs'];
const publicSessionKeys = ['sessionId', 'title', 'status', 'closedAt', 'deletedAt'];
const publicLogKeys = [
  'syncId',
  'controller',
  'callsign',
  'time',
  'rstSent',
  'rstRcvd',
  'qth',
  'device',
  'power',
  'antenna',
  'height',
  'remarks',
  'deletedAt',
];
const publicEventKeys = [
  'protocolVersion',
  'eventId',
  'sessionId',
  'seq',
  'type',
  'entityType',
  'entityId',
  'occurredAt',
  'payload',
];
const publicShareKeys = [
  'publicShareId',
  'sessionId',
  'expiresAt',
  'createdBy',
  'createdAt',
  'revokedAt',
  'revokedBy',
];

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function exactKeys(value: JsonObject, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function success(result: HttpResult, expected = 200): JsonObject {
  assert.equal(result.status, expected, result.text);
  return result.body;
}

function assertError(result: HttpResult, status: number, code: string): void {
  assert.equal(result.status, status, result.text);
  assertObject(result.body.error, 'error');
  assert.equal(result.body.error.code, code, result.text);
}

function errorSignature(result: HttpResult): { status: number; code: string; message: string } {
  assertObject(result.body.error, 'error');
  return {
    status: result.status,
    code: String(result.body.error.code),
    message: String(result.body.error.message),
  };
}

function parseJsonObject(text: string): JsonObject {
  const parsed = text ? (JSON.parse(text) as unknown) : {};
  assertObject(parsed, 'HTTP response');
  return parsed;
}

function rowText(row: object | undefined): string {
  assert.ok(row, 'expected a database row');
  return JSON.stringify(row);
}

class WsInbox {
  readonly queued: JsonObject[] = [];
  private readonly waiters: Array<{
    resolve: (message: JsonObject) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as unknown;
      assertObject(parsed, 'WebSocket message');
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      } else {
        this.queued.push(parsed);
      }
    });
    this.closed = new Promise((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  async next(timeoutMs = 4_000): Promise<JsonObject> {
    const queued = this.queued.shift();
    if (queued) return queued;
    return new Promise<JsonObject>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('Timed out waiting for WebSocket message'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

describe('public Liveshare v1 capability', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let wsController: CollaborationWsController;
  let baseUrl: string;
  let wsBaseUrl: string;
  const actors = new Map<string, Actor>();

  const config: PublicLiveshareConfig = {
    port: 0,
    dbPath: ':memory:',
    jwtSecret: 'public-live-test-jwt-secret-f78856ae-9df3-45ce-944c-0a3d04ece425',
    jwtIssuer: 'openlogtool-public-live-test',
    bootstrapSecret: 'public-live-bootstrap-secret-8f5b0a9c',
    inviteHmacKey: 'public-live-invite-hmac-key-9b230ddf-80da-43a4-9c5d',
    publicShareHmacKey: 'public-share-independent-hmac-key-0477fe51-5f83-4db2-b099',
    publicAccessTokenTtlSeconds: 300,
    accessTokenTtlSeconds: 300,
    refreshTokenTtlSeconds: 3_600,
    corsOrigins: ['https://public.example'],
    trustProxy: false,
    jsonBodyLimit: '1mb',
    rateLimitEnabled: false,
    environment: 'test',
  };

  function memberAccessToken(userId: string, role: Actor['role']): string {
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

  function actor(name: string): Actor {
    const value = actors.get(name);
    assert.ok(value, `missing actor ${name}`);
    return value;
  }

  async function request(
    path: string,
    options: {
      method?: string;
      actor?: Actor;
      token?: string;
      body?: unknown;
      idempotencyKey?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': randomUUID(),
        ...(options.actor
          ? { authorization: `Bearer ${options.actor.accessToken}` }
          : options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(6_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: parseJsonObject(text),
      text,
    };
  }

  async function createSession(title: string, includeEditor = false): Promise<string> {
    const sessionId = randomUUID();
    success(
      await request(`/api/v1/sessions/${sessionId}`, {
        method: 'PUT',
        actor: actor('owner'),
        idempotencyKey: randomUUID(),
        headers: { 'x-device-id': deviceId },
        body: { title },
      }),
      201,
    );
    success(
      await request(`/api/v1/sessions/${sessionId}/activate`, {
        method: 'POST',
        actor: actor('owner'),
        idempotencyKey: randomUUID(),
        headers: { 'x-device-id': deviceId },
        body: { expectedLogCount: 0 },
      }),
    );
    if (includeEditor) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO session_members (
          id, session_id, user_id, role, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'editor', 1, ?, ?)
      `).run(randomUUID(), sessionId, actor('editor').id, now, now);
    }
    return sessionId;
  }

  async function createShare(
    sessionId: string,
    mutationId = randomUUID(),
    expiresInHours = 24,
  ): Promise<{ result: HttpResult; share: PublicShareSecret; mutationId: string }> {
    const body = { expiresInHours };
    const result = await request(`/api/v1/sessions/${sessionId}/public-shares`, {
      method: 'POST',
      actor: actor('owner'),
      idempotencyKey: mutationId,
      body,
    });
    const response = success(result, 201);
    assertObject(response.publicShare, 'publicShare');
    assert.equal(typeof response.publicShare.publicShareId, 'string');
    assert.equal(typeof response.publicShare.secret, 'string');
    return {
      result,
      mutationId,
      share: {
        publicShareId: String(response.publicShare.publicShareId),
        secret: String(response.publicShare.secret),
        body,
      },
    };
  }

  async function exchange(
    share: PublicShareSecret,
    viewSessionId?: string,
  ): Promise<{ result: HttpResult; access: PublicAccess }> {
    const result = await request(`/api/v1/public-shares/${share.publicShareId}/exchange`, {
      method: 'POST',
      body: {
        secret: share.secret,
        ...(viewSessionId ? { viewSessionId } : {}),
      },
    });
    const response = success(result);
    assert.equal(typeof response.accessToken, 'string');
    assert.equal(response.tokenType, 'Bearer');
    assert.equal(typeof response.expiresAt, 'string');
    return {
      result,
      access: {
        accessToken: String(response.accessToken),
        expiresAt: String(response.expiresAt),
      },
    };
  }

  async function publicLiveshareStats(limit = 100): Promise<HttpResult> {
    return request(`/api/v1/admin/public-liveshare-stats?limit=${limit}`, {
      actor: actor('global-admin'),
    });
  }

  async function publicLiveshareDetail(publicShareId: string): Promise<HttpResult> {
    return request(
      `/api/v1/admin/public-liveshare-stats/${encodeURIComponent(publicShareId)}`,
      { actor: actor('global-admin') },
    );
  }

  function insertShareFixture(
    sessionId: string,
    createdAt: string,
    expiresAt: string,
  ): PublicShareSecret {
    const publicShareId = randomUUID();
    const secret = derivePublicShareSecret(config, publicShareId);
    db.prepare(`
      INSERT INTO public_shares (
        id, session_id, credential_version, secret_hash,
        expires_at, created_by, created_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)
    `).run(
      publicShareId,
      sessionId,
      hashPublicShareSecret(config, secret),
      expiresAt,
      actor('owner').id,
      createdAt,
    );
    return { publicShareId, secret, body: { expiresInHours: null } };
  }

  function insertShortLivedShare(sessionId: string, lifetimeMs: number): PublicShareSecret {
    const now = new Date();
    return insertShareFixture(
      sessionId,
      now.toISOString(),
      new Date(now.getTime() + lifetimeMs).toISOString(),
    );
  }

  function insertExpiredShare(sessionId: string): PublicShareSecret {
    return insertShareFixture(
      sessionId,
      '1999-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
    );
  }

  async function publicSnapshot(sessionId: string, accessToken: string): Promise<HttpResult> {
    return request(`/api/v1/public/sessions/${sessionId}/snapshot`, { token: accessToken });
  }

  async function publicTicket(
    sessionId: string,
    accessToken: string,
    afterSeq: number,
  ): Promise<{ result: HttpResult; ticket: string }> {
    const result = await request(`/api/v1/public/sessions/${sessionId}/ws-ticket`, {
      method: 'POST',
      token: accessToken,
      body: { afterSeq },
    });
    const response = success(result);
    assert.equal(response.afterSeq, afterSeq);
    assert.equal(typeof response.ticket, 'string');
    return { result, ticket: String(response.ticket) };
  }

  async function connectPublic(
    ticket: string,
    headers: Record<string, string> = { origin: 'https://public.example' },
  ): Promise<WsInbox> {
    const ws = new WebSocket(`${wsBaseUrl}/ws/public?ticket=${encodeURIComponent(ticket)}`, {
      headers,
    });
    const inbox = new WsInbox(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return inbox;
  }

  async function rejectedWs(
    path: string,
    expectedStatus = 401,
    options: { origin?: string; headers?: Record<string, string> } = {
      origin: 'https://public.example',
    },
  ): Promise<void> {
    const headers = options.headers ?? (
      options.origin === undefined ? undefined : { origin: options.origin }
    );
    const ws = headers === undefined
      ? new WebSocket(`${wsBaseUrl}${path}`)
      : new WebSocket(`${wsBaseUrl}${path}`, {
          headers,
        });
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

  async function createLog(
    sessionId: string,
    callsign: string,
    remarks: string,
  ): Promise<{ mutationId: string; event: JsonObject }> {
    const mutationId = randomUUID();
    const syncId = randomUUID();
    const response = success(
      await request(`/api/v1/sessions/${sessionId}/mutations`, {
        method: 'POST',
        actor: actor('owner'),
        body: {
          protocolVersion: 1,
          deviceId: sourceDeviceSentinel,
          operations: [
            {
              mutationId,
              entityType: 'log',
              entityId: syncId,
              operation: 'create',
              baseVersion: 0,
              value: {
                syncId,
                sessionId,
                time: '2026-07-12T12:34:56.000Z',
                controller: 'bg5crl',
                callsign,
                rstSent: '59',
                rstRcvd: '57',
                qth: 'Shanghai',
                device: 'IC-705',
                power: '10W',
                antenna: 'DP',
                height: '8m',
                remarks,
              },
            },
          ],
        },
      }),
    );
    assert.ok(Array.isArray(response.results));
    assertObject(response.results[0], 'mutation result');
    assert.equal(response.results[0].status, 'accepted');
    assertObject(response.results[0].event, 'accepted event');
    return { mutationId, event: response.results[0].event };
  }

  function insertSnapshotByteFixtures(sessionId: string): void {
    // NUL is one UTF-8 byte in SQLite but six bytes once JSON escaped as
    // "\\u0000". This reaches the serialized limit with a small (~1.4 MiB)
    // fixture instead of constructing a 20,000-row stress test.
    const escapedRemarks = '\0'.repeat(2_000);
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO logs (
        sync_id, session_id, controller, callsign, time,
        remarks, created_at, updated_at, created_by, updated_by, source_device_id
      ) VALUES (?, ?, 'PUB', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (let index = 0; index < 710; index += 1) {
        insert.run(
          randomUUID(),
          sessionId,
          `B${String(index).padStart(5, '0')}`,
          `2026-07-12T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
          escapedRemarks,
          now,
          now,
          actor('owner').id,
          actor('owner').id,
          sourceDeviceSentinel,
        );
      }
    }).immediate();
    assert.ok(
      Buffer.byteLength(JSON.stringify(escapedRemarks)) * 710 > publicSnapshotMaxBytes,
      'fixture must exceed the serialized public snapshot byte limit',
    );
  }

  function insertRecentlyExpiredPublicTicket(publicShareId: string): string {
    const now = Date.now();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO public_ws_tickets (
        id, token_hash, public_share_id, access_token_id, after_seq,
        authorization_expires_at, issued_ip, created_at, expires_at
      ) VALUES (?, ?, ?, ?, 0, ?, '127.0.0.1', ?, ?)
    `).run(
      id,
      hashPublicWsTicket(`expired-${id}`),
      publicShareId,
      `expired-access-${id}`,
      new Date(now + 60_000).toISOString(),
      new Date(now - 120_000).toISOString(),
      new Date(now - 60_000).toISOString(),
    );
    return id;
  }

  function insertMalformedPublicBacklogEvent(sessionId: string): number {
    const session = db.prepare(`
      SELECT event_seq FROM sessions WHERE id = ?
    `).get(sessionId) as { event_seq: number };
    const seq = Number(session.event_seq) + 1;
    const eventId = randomUUID();
    const entityId = randomUUID();
    const mutationId = randomUUID();
    const occurredAt = new Date().toISOString();
    const malformedEvent = {
      protocolVersion: 1,
      eventId,
      sessionId,
      seq,
      type: 'log.created',
      entityType: 'log',
      entityId,
      entityVersion: 1,
      mutationId,
      actor: {
        userId: actor('owner').id,
        deviceId,
        displayName: `${actor('owner').id}-private-name`,
      },
      occurredAt,
      // A public Log projection requires controller/callsign/time and all
      // nullable business fields. Keeping only syncId simulates a corrupted
      // or future-incompatible stored event without invalid JSON.
      payload: { syncId: entityId },
    };
    db.transaction(() => {
      db.prepare('UPDATE sessions SET event_seq = ? WHERE id = ?').run(seq, sessionId);
      db.prepare(`
        INSERT INTO session_events (
          id, session_id, seq, type, entity_type, entity_id, entity_version,
          mutation_id, actor_user_id, actor_device_id, payload_json, occurred_at
        ) VALUES (?, ?, ?, 'log.created', 'log', ?, 1, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        sessionId,
        seq,
        entityId,
        mutationId,
        actor('owner').id,
        deviceId,
        JSON.stringify(malformedEvent),
        occurredAt,
      );
    }).immediate();
    return seq;
  }

  async function mutateSession(
    sessionId: string,
    operation: 'close' | 'delete',
  ): Promise<JsonObject> {
    const session = db.prepare('SELECT version FROM sessions WHERE id = ?').get(sessionId) as {
      version: number;
    };
    const result = success(
      await request(`/api/v1/sessions/${sessionId}/mutations`, {
        method: 'POST',
        actor: actor('owner'),
        body: {
          protocolVersion: 1,
          deviceId,
          operations: [
            {
              mutationId: randomUUID(),
              entityType: 'session',
              entityId: sessionId,
              operation,
              baseVersion: session.version,
            },
          ],
        },
      }),
    );
    assert.ok(Array.isArray(result.results));
    assertObject(result.results[0], `${operation} result`);
    assert.equal(result.results[0].status, 'accepted');
    return result.results[0];
  }

  function auditRows(sessionId: string, action: string): AuditRow[] {
    return db.prepare(`
      SELECT
        id, action, actor_user_id, target_user_id, request_id, mutation_id,
        before_json, after_json, details_json
      FROM collaboration_audit_events
      WHERE session_id = ? AND action = ?
      ORDER BY occurred_at DESC, id DESC
    `).all(sessionId, action) as AuditRow[];
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-live-'));
    config.dbPath = join(directory, 'public-live.db');
    db = openDatabase(config.dbPath);
    const now = new Date().toISOString();
    const definitions: Array<Pick<Actor, 'id' | 'role'>> = [
      { id: 'public-owner', role: 'user' },
      { id: 'public-editor', role: 'user' },
      { id: 'public-outsider', role: 'user' },
      { id: 'public-global-admin', role: 'admin' },
    ];
    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const definition of definitions) {
      insertUser.run(
        definition.id,
        `${definition.id}-private-name`,
        `${passwordSentinel}-${definition.id}`,
        definition.role,
        now,
        now,
      );
      actors.set(definition.id.replace('public-', ''), {
        ...definition,
        accessToken: memberAccessToken(definition.id, definition.role),
      });
    }

    server = createServer(createApp({ db, config }));
    wsController = createCollaborationWsServer(server, { db, config });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;
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

  test('Owner creates, lists and exactly replays a share without persisting its secret', async () => {
    const sessionId = await createSession('Public secret safety');
    const mutationId = randomUUID();
    const created = await createShare(sessionId, mutationId);
    const createdBody = created.result.body;
    assertObject(createdBody.publicShare, 'publicShare');
    const secret = created.share.secret;
    assert.ok(secret.length >= 32);
    exactKeys(createdBody.publicShare, [...publicShareKeys, 'secret']);
    assert.equal(createdBody.publicShare.sessionId, sessionId);
    assert.equal(createdBody.publicShare.revokedAt, null);
    assert.equal(createdBody.publicShare.revokedBy, null);
    assert.equal(created.result.headers.get('cache-control'), 'no-store');

    const shareRow = db.prepare('SELECT * FROM public_shares WHERE id = ?').get(
      created.share.publicShareId,
    ) as Record<string, unknown> | undefined;
    assert.equal(rowText(shareRow).includes(secret), false, 'public_shares leaked the link secret');
    const processed = db.prepare(`
      SELECT request_hash, response_json FROM processed_mutations WHERE mutation_id = ?
    `).get(mutationId) as Record<string, unknown> | undefined;
    assert.equal(rowText(processed).includes(secret), false, 'processed response leaked the link secret');
    const createdAudit = auditRows(sessionId, 'public_share.created');
    assert.equal(createdAudit.length, 1);
    assert.equal(createdAudit[0].actor_user_id, actor('owner').id);
    assert.equal(createdAudit[0].target_user_id, null);
    assert.equal(createdAudit[0].mutation_id, mutationId);
    assert.equal(rowText(createdAudit[0]).includes(secret), false, 'audit leaked the link secret');

    const replay = await request(`/api/v1/sessions/${sessionId}/public-shares`, {
      method: 'POST',
      actor: actor('owner'),
      idempotencyKey: mutationId,
      body: created.share.body,
    });
    assert.equal(replay.status, 201, replay.text);
    assert.equal(replay.headers.get('idempotent-replay'), 'true');
    assert.deepEqual(replay.body, createdBody);
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) FROM public_shares WHERE session_id = ?').pluck().get(sessionId)),
      1,
    );
    assert.equal(auditRows(sessionId, 'public_share.created').length, 1);

    const listed = await request(`/api/v1/sessions/${sessionId}/public-shares`, {
      actor: actor('owner'),
    });
    const listedBody = success(listed);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    assert.ok(Array.isArray(listedBody.publicShares));
    assert.equal(listedBody.publicShares.length, 1);
    assertObject(listedBody.publicShares[0], 'listed public share');
    exactKeys(listedBody.publicShares[0], publicShareKeys);
    assert.equal(listed.text.includes(secret), false);
    assert.equal(listed.text.includes('tokenHash'), false);
  });

  test('public-share lifetime defaults to 24 hours and accepts only 1 through 720 whole hours', async () => {
    const sessionId = await createSession('Public share lifetime contract');

    const createWithBody = async (body: JsonObject): Promise<JsonObject> => {
      const result = await request(`/api/v1/sessions/${sessionId}/public-shares`, {
        method: 'POST',
        actor: actor('owner'),
        idempotencyKey: randomUUID(),
        body,
      });
      const response = success(result, 201);
      assertObject(response.publicShare, 'publicShare');
      return response.publicShare;
    };
    const assertLifetime = (share: JsonObject, hours: number) => {
      const createdAt = Date.parse(String(share.createdAt));
      const expiresAt = Date.parse(String(share.expiresAt));
      assert.equal(expiresAt - createdAt, hours * 3_600_000);
    };

    assertLifetime(await createWithBody({}), 24);
    assertLifetime(await createWithBody({ expiresInHours: 1 }), 1);
    assertLifetime(await createWithBody({ expiresInHours: 720 }), 720);

    for (const invalidLifetime of [0, 721, 1.5, '24', null]) {
      assertError(
        await request(`/api/v1/sessions/${sessionId}/public-shares`, {
          method: 'POST',
          actor: actor('owner'),
          idempotencyKey: randomUUID(),
          body: { expiresInHours: invalidLifetime },
        }),
        422,
        'VALIDATION_FAILED',
      );
    }
  });

  test('public-share history uses a strict bounded opaque cursor', async () => {
    const sessionId = await createSession('Public share cursor contract');
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const expectedIds = Array.from({ length: 5 }, () => (
      insertShareFixture(sessionId, createdAt, expiresAt).publicShareId
    )).sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));

    const observedIds: string[] = [];
    let after: string | null = null;
    let firstCursor: string | null = null;
    do {
      const suffix = `?limit=2${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const result = await request(`/api/v1/sessions/${sessionId}/public-shares${suffix}`, {
        actor: actor('owner'),
      });
      const page = success(result);
      exactKeys(page, ['publicShares', 'nextCursor']);
      assert.ok(Array.isArray(page.publicShares));
      assert.ok(page.publicShares.length >= 1 && page.publicShares.length <= 2);
      for (const item of page.publicShares) {
        assertObject(item, 'paginated public share');
        exactKeys(item, publicShareKeys);
        observedIds.push(String(item.publicShareId));
      }
      assert.ok(page.nextCursor === null || typeof page.nextCursor === 'string');
      after = page.nextCursor === null ? null : String(page.nextCursor);
      firstCursor ??= after;
    } while (after);
    assert.deepEqual(observedIds, expectedIds, 'cursor must preserve the full stable DESC order');
    assert.equal(new Set(observedIds).size, expectedIds.length, 'cursor repeated a share');
    assert.equal(typeof firstCursor, 'string');

    const historySessionId = await createSession('Public share default page size');
    for (let index = 0; index < 51; index += 1) {
      insertShareFixture(
        historySessionId,
        '2000-01-01T00:00:00.000Z',
        '2001-01-01T00:00:00.000Z',
      );
    }
    const defaultPage = success(
      await request(`/api/v1/sessions/${historySessionId}/public-shares`, {
        actor: actor('owner'),
      }),
    );
    exactKeys(defaultPage, ['publicShares', 'nextCursor']);
    assert.ok(Array.isArray(defaultPage.publicShares));
    assert.equal(defaultPage.publicShares.length, 50, 'default page size must be 50');
    assert.equal(typeof defaultPage.nextCursor, 'string');
    const defaultTail = success(
      await request(
        `/api/v1/sessions/${historySessionId}/public-shares?after=${encodeURIComponent(
          String(defaultPage.nextCursor),
        )}`,
        { actor: actor('owner') },
      ),
    );
    assert.ok(Array.isArray(defaultTail.publicShares));
    assert.equal(defaultTail.publicShares.length, 1);
    assert.equal(defaultTail.nextCursor, null);

    for (const query of [
      '?unknown=true',
      '?limit=',
      '?limit=0',
      '?limit=51',
      '?limit=1.5',
      '?limit=1&limit=2',
      '?after=',
      '?after=not-a-valid-opaque-cursor',
      `?after=${encodeURIComponent(firstCursor!)}&after=${encodeURIComponent(firstCursor!)}`,
    ]) {
      assertError(
        await request(`/api/v1/sessions/${sessionId}/public-shares${query}`, {
          actor: actor('owner'),
        }),
        422,
        'VALIDATION_FAILED',
      );
    }
  });

  test('public-share administration is current-Owner-only and global admin cannot bypass IDOR', async () => {
    const sessionId = await createSession('Public share object authorization', true);
    const created = await createShare(sessionId);

    assertError(
      await request(`/api/v1/sessions/${sessionId}/public-shares`, { actor: actor('editor') }),
      403,
      'FORBIDDEN',
    );
    assertError(
      await request(`/api/v1/sessions/${sessionId}/public-shares`, {
        method: 'POST',
        actor: actor('editor'),
        idempotencyKey: randomUUID(),
        body: { expiresInHours: 24 },
      }),
      403,
      'FORBIDDEN',
    );
    for (const acting of [actor('outsider'), actor('global-admin')]) {
      assertError(
        await request(`/api/v1/sessions/${sessionId}/public-shares`, { actor: acting }),
        404,
        'NOT_FOUND',
      );
      const deniedMutation = randomUUID();
      assertError(
        await request(`/api/v1/sessions/${sessionId}/public-shares`, {
          method: 'POST',
          actor: acting,
          idempotencyKey: deniedMutation,
          body: { expiresInHours: 24 },
        }),
        404,
        'NOT_FOUND',
      );
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
          deniedMutation,
        )),
        0,
      );
    }
    assertError(
      await request(
        `/api/v1/sessions/${sessionId}/public-shares/${created.share.publicShareId}`,
        {
          method: 'DELETE',
          actor: actor('editor'),
          idempotencyKey: randomUUID(),
        },
      ),
      403,
      'FORBIDDEN',
    );
    assertError(
      await request(
        `/api/v1/sessions/${sessionId}/public-shares/${created.share.publicShareId}`,
        {
          method: 'DELETE',
          actor: actor('global-admin'),
          idempotencyKey: randomUUID(),
        },
      ),
      404,
      'NOT_FOUND',
    );
  });

  test('exchange has one indistinguishable failure and public/member bearer tokens are mutually exclusive', async () => {
    const sessionId = await createSession('Public exchange token boundary');
    const created = await createShare(sessionId);
    const exchanged = await exchange(created.share);
    assert.equal(exchanged.result.headers.get('cache-control'), 'no-store');
    assertObject(exchanged.result.body.publicShare, 'exchange publicShare');
    exactKeys(exchanged.result.body.publicShare, ['publicShareId', 'sessionId', 'expiresAt']);
    assert.equal(exchanged.result.body.publicShare.publicShareId, created.share.publicShareId);
    assert.equal(exchanged.result.body.publicShare.sessionId, sessionId);

    const payload = jwt.decode(exchanged.access.accessToken) as JwtPayload;
    assert.equal(payload.type, 'public-share-access');
    assert.equal(payload.aud, 'openlogtool-public-v1');
    assert.equal(payload.publicShareId, created.share.publicShareId);
    assert.equal(payload.sessionId, sessionId);
    assert.equal(typeof payload.jti, 'string');
    assert.equal(payload.sub, undefined);
    assert.equal(payload.role, undefined);
    assert.ok(Number(payload.exp) - Number(payload.iat) <= 300);

    assertError(
      await request(`/api/v1/sessions/${sessionId}/snapshot`, {
        token: exchanged.access.accessToken,
      }),
      401,
      'TOKEN_INVALID',
    );
    assertError(
      await publicSnapshot(sessionId, actor('owner').accessToken),
      401,
      'PUBLIC_ACCESS_INVALID',
    );

    const unknown = await request(`/api/v1/public-shares/${randomUUID()}/exchange`, {
      method: 'POST',
      body: { secret: created.share.secret },
    });
    const wrongSecret = await request(
      `/api/v1/public-shares/${created.share.publicShareId}/exchange`,
      {
        method: 'POST',
        body: {
          secret: `${created.share.secret.slice(0, -1)}${created.share.secret.endsWith('A') ? 'B' : 'A'}`,
        },
      },
    );

    const expiredShare = insertExpiredShare(sessionId);
    const expiredResult = await request(
      `/api/v1/public-shares/${expiredShare.publicShareId}/exchange`,
      { method: 'POST', body: { secret: expiredShare.secret } },
    );

    const revoked = await createShare(sessionId);
    success(
      await request(
        `/api/v1/sessions/${sessionId}/public-shares/${revoked.share.publicShareId}`,
        {
          method: 'DELETE',
          actor: actor('owner'),
          idempotencyKey: randomUUID(),
        },
      ),
    );
    const revokedResult = await request(
      `/api/v1/public-shares/${revoked.share.publicShareId}/exchange`,
      { method: 'POST', body: { secret: revoked.share.secret } },
    );

    const expected = errorSignature(unknown);
    assert.deepEqual(expected, {
      status: 404,
      code: 'PUBLIC_SHARE_INVALID',
      message: 'Public share is invalid or unavailable',
    });
    assert.deepEqual(errorSignature(wrongSecret), expected);
    assert.deepEqual(errorSignature(expiredResult), expected);
    assert.deepEqual(errorSignature(revokedResult), expected);
  });

  test('administrator Live Share statistics report visitor IP and exact active sessions without exposing raw view IDs', async () => {
    const sessionId = await createSession('Anonymous Live Share analytics');
    const created = await createShare(sessionId);
    const firstViewId = randomUUID();
    const secondViewId = randomUUID();

    assertError(
      await request('/api/v1/admin/public-liveshare-stats'),
      401,
      'AUTH_REQUIRED',
    );
    assertError(
      await request('/api/v1/admin/public-liveshare-stats', { actor: actor('owner') }),
      403,
      'ADMIN_REQUIRED',
    );
    assertError(
      await request(
        `/api/v1/admin/public-liveshare-stats/${created.share.publicShareId}`,
        { actor: actor('owner') },
      ),
      403,
      'ADMIN_REQUIRED',
    );
    assertError(
      await publicLiveshareDetail('not a stable id'),
      422,
      'VALIDATION_FAILED',
    );
    assertError(
      await publicLiveshareDetail('00000000-0000-4000-8000-000000000000'),
      404,
      'PUBLIC_SHARE_NOT_FOUND',
    );
    assertError(
      await request('/api/v1/admin/public-liveshare-stats?unexpected=true', {
        actor: actor('global-admin'),
      }),
      422,
      'VALIDATION_FAILED',
    );
    assertError(
      await request('/api/v1/admin/public-liveshare-stats?limit=101', {
        actor: actor('global-admin'),
      }),
      422,
      'VALIDATION_FAILED',
    );
    assertError(
      await request(`/api/v1/public-shares/${created.share.publicShareId}/exchange`, {
        method: 'POST',
        body: { secret: created.share.secret, viewSessionId: 'not-a-random-uuid' },
      }),
      422,
      'VALIDATION_FAILED',
    );

    const firstAccess = await exchange(created.share, firstViewId);
    await exchange(created.share, firstViewId);
    const secondAccess = await exchange(created.share, secondViewId);
    const invalidSecret = `${created.share.secret.slice(0, -1)}${created.share.secret.endsWith('A') ? 'B' : 'A'}`;
    assertError(
      await request(`/api/v1/public-shares/${created.share.publicShareId}/exchange`, {
        method: 'POST',
        body: { secret: invalidSecret, viewSessionId: randomUUID() },
      }),
      404,
      'PUBLIC_SHARE_INVALID',
    );

    const firstSnapshot = success(await publicSnapshot(sessionId, firstAccess.access.accessToken));
    const secondSnapshot = success(await publicSnapshot(sessionId, secondAccess.access.accessToken));
    const firstTicket = await publicTicket(
      sessionId,
      firstAccess.access.accessToken,
      Number(firstSnapshot.highWatermarkSeq),
    );
    const secondTicket = await publicTicket(
      sessionId,
      secondAccess.access.accessToken,
      Number(secondSnapshot.highWatermarkSeq),
    );
    const firstSocket = await connectPublic(firstTicket.ticket);
    const secondSocket = await connectPublic(secondTicket.ticket);

    const whileOpenResult = await publicLiveshareStats();
    const whileOpen = success(whileOpenResult);
    assert.equal(whileOpenResult.headers.get('cache-control'), 'no-store');
    exactKeys(whileOpen, ['schemaVersion', 'generatedAt', 'scope', 'totals', 'items']);
    assert.equal(whileOpen.schemaVersion, 1);
    assertObject(whileOpen.scope, 'public Liveshare statistics scope');
    assert.equal(whileOpen.scope.currentConnections, 'current-process');
    assert.equal(whileOpen.scope.openCounts, 'current-database');
    assert.equal(whileOpen.scope.anonymousPageSessions, true);
    assert.equal(typeof whileOpen.scope.trackingStartedAt, 'string');
    assert.deepEqual(whileOpen.scope.viewSessionDetailLimits, {
      perShare: 10_000,
      total: 100_000,
    });
    assert.equal(whileOpen.scope.visitorDetailLimit, 200);
    assert.equal(whileOpen.scope.visitorIpSource, 'trusted-request-ip');
    assertObject(whileOpen.totals, 'public Liveshare statistics totals');
    assert.ok(Number(whileOpen.totals.currentConnections) >= 2);
    assert.ok(Number(whileOpen.totals.totalOpens) >= 2);
    assert.equal(Number(whileOpen.totals.saturatedShares), 0);
    assert.ok(Array.isArray(whileOpen.items));
    const item = whileOpen.items.find((value) => (
      value && typeof value === 'object' &&
      (value as JsonObject).publicShareId === created.share.publicShareId
    ));
    assertObject(item, 'public Liveshare statistics item');
    assert.equal(item.sessionId, sessionId);
    assert.equal(item.sessionTitle, 'Anonymous Live Share analytics');
    assert.equal(item.state, 'active');
    assert.equal(item.currentConnections, 2);
    assert.equal(item.totalOpens, 2, 'five-minute access renewal must not count as another open');
    assert.equal(item.openCountSaturated, false);
    assert.equal(item.openCountSaturatedAt, null);
    assert.equal(typeof item.firstOpenedAt, 'string');
    assert.equal(typeof item.lastOpenedAt, 'string');
    assert.equal(typeof item.lastAccessedAt, 'string');

    const detailResult = await publicLiveshareDetail(created.share.publicShareId);
    const detail = success(detailResult);
    assert.equal(detailResult.headers.get('cache-control'), 'no-store');
    exactKeys(detail, ['schemaVersion', 'generatedAt', 'scope', 'item', 'visitors']);
    assert.equal(detail.schemaVersion, 3);
    assertObject(detail.scope, 'public Liveshare detail scope');
    assertObject(detail.item, 'public Liveshare detail item');
    assert.equal(detail.item.publicShareId, created.share.publicShareId);
    assert.equal(detail.item.sessionId, sessionId);
    assert.equal(detail.item.currentConnections, 2);
    assert.equal(detail.item.totalOpens, 2);
    assert.ok(Array.isArray(detail.visitors));
    assert.equal(detail.visitors.length, 1);
    for (const visitor of detail.visitors) {
      assertObject(visitor, 'public Liveshare visitor');
      exactKeys(visitor, [
        'ipAddress',
        'firstSeenAt',
        'lastSeenAt',
        'visitCount',
        'currentConnections',
        'location',
      ]);
      assert.equal(typeof visitor.ipAddress, 'string');
      assert.equal(typeof visitor.firstSeenAt, 'string');
      assert.equal(typeof visitor.lastSeenAt, 'string');
      assert.equal(visitor.visitCount, 2);
      assert.equal(visitor.currentConnections, 2);
      assert.equal(visitor.location, null);
    }

    const storedViewSessions = JSON.stringify(db.prepare(`
      SELECT * FROM public_share_view_sessions WHERE public_share_id = ?
    `).all(created.share.publicShareId));
    assert.equal(storedViewSessions.includes(firstViewId), false);
    assert.equal(storedViewSessions.includes(secondViewId), false);
    assert.equal(JSON.stringify(whileOpen).includes(firstViewId), false);
    assert.equal(JSON.stringify(whileOpen).includes(secondViewId), false);
    assert.equal(JSON.stringify(detail).includes(firstViewId), false);
    assert.equal(JSON.stringify(detail).includes(secondViewId), false);

    firstSocket.ws.close(1000, 'analytics test complete');
    secondSocket.ws.close(1000, 'analytics test complete');
    await Promise.all([firstSocket.closed, secondSocket.closed]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const afterClose = success(await publicLiveshareStats());
    assert.ok(Array.isArray(afterClose.items));
    const closedItem = afterClose.items.find((value) => (
      value && typeof value === 'object' &&
      (value as JsonObject).publicShareId === created.share.publicShareId
    ));
    assertObject(closedItem, 'closed public Liveshare statistics item');
    assert.equal(closedItem.currentConnections, 0);
    assert.equal(closedItem.totalOpens, 2);

    const closedDetail = success(
      await publicLiveshareDetail(created.share.publicShareId),
    );
    assertObject(closedDetail.item, 'closed public Liveshare detail item');
    assert.equal(closedDetail.item.currentConnections, 0);
    assert.equal(closedDetail.item.totalOpens, 2);
    assert.ok(Array.isArray(closedDetail.visitors));
    assert.equal(closedDetail.visitors.length, 1);
    assert.ok(closedDetail.visitors.every((visitor) => (
      visitor && typeof visitor === 'object' &&
      Number((visitor as JsonObject).currentConnections) === 0
    )));

  });

  test('public snapshot has an exact business-only DTO and never exposes identity or replication metadata', async () => {
    const sessionId = await createSession('Public DTO title');
    const canonical = await createLog(sessionId, 'BA4PUB', 'public remarks');
    const created = await createShare(sessionId);
    const exchanged = await exchange(created.share);

    const result = await publicSnapshot(sessionId, exchanged.access.accessToken);
    const snapshot = success(result);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    exactKeys(snapshot, publicSnapshotKeys);
    assert.equal(snapshot.protocolVersion, 1);
    assertObject(snapshot.session, 'public session');
    exactKeys(snapshot.session, publicSessionKeys);
    assert.equal(snapshot.session.sessionId, sessionId);
    assert.equal(snapshot.session.title, 'Public DTO title');
    assert.equal(snapshot.session.status, 'active');
    assert.equal(snapshot.session.deletedAt, null);
    assert.equal(snapshot.highWatermarkSeq, canonical.event.seq);
    assert.ok(Array.isArray(snapshot.logs));
    assert.equal(snapshot.logs.length, 1);
    assertObject(snapshot.logs[0], 'public log');
    exactKeys(snapshot.logs[0], publicLogKeys);
    assert.equal(snapshot.logs[0].callsign, 'BA4PUB');
    assert.equal(
      snapshot.logs[0].time,
      '2026-07-12T12:34:56.000Z',
      'public snapshots must preserve record seconds',
    );
    assert.equal(snapshot.logs[0].remarks, 'public remarks');
    assert.equal(snapshot.logs[0].deletedAt, null);

    for (const forbidden of [
      actor('owner').id,
      `${actor('owner').id}-private-name`,
      passwordSentinel,
      sourceDeviceSentinel,
      canonical.mutationId,
      'createdBy',
      'updatedBy',
      'deletedBy',
      'sourceDeviceId',
      'entityVersion',
      'mutationId',
      'actor',
    ]) {
      assert.equal(result.text.includes(forbidden), false, `public snapshot leaked ${forbidden}`);
    }
  });

  test('public snapshot enforces an 8 MiB serialized byte ceiling before sending Logs', async () => {
    const sessionId = await createSession('Public snapshot byte ceiling');
    insertSnapshotByteFixtures(sessionId);
    const created = await createShare(sessionId);
    const exchanged = await exchange(created.share);

    const result = await publicSnapshot(sessionId, exchanged.access.accessToken);
    assertError(result, 413, 'PUBLIC_SNAPSHOT_TOO_LARGE');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal('logs' in result.body, false, 'oversized snapshot must not emit a partial Log array');
  });

  test('snapshot to public WebSocket backlog and live delivery is continuous and strictly redacted', async () => {
    const sessionId = await createSession('Public backlog and live');
    await createLog(sessionId, 'BA4OLD', 'before snapshot');
    const created = await createShare(sessionId);
    const exchanged = await exchange(created.share);
    const snapshot = success(await publicSnapshot(sessionId, exchanged.access.accessToken));
    const snapshotHead = Number(snapshot.highWatermarkSeq);

    const backlogMutation = await createLog(sessionId, 'BA4BACK', 'between snapshot and ticket');
    assert.equal(Number(backlogMutation.event.seq), snapshotHead + 1);
    const ticket = await publicTicket(sessionId, exchanged.access.accessToken, snapshotHead);
    assert.equal(ticket.result.headers.get('cache-control'), 'no-store');
    const inbox = await connectPublic(ticket.ticket);

    const hello = await inbox.next();
    assert.equal(hello.type, 'hello');
    assert.equal(hello.sessionId, sessionId);
    assert.equal(hello.headSeq, snapshotHead + 1);

    const backlogMessage = await inbox.next();
    assert.equal(backlogMessage.type, 'event');
    assertObject(backlogMessage.event, 'public backlog event');
    exactKeys(backlogMessage.event, publicEventKeys);
    assert.equal(backlogMessage.event.seq, snapshotHead + 1);
    assert.equal(backlogMessage.event.type, 'log.created');
    assert.equal('actor' in backlogMessage.event, false);
    assert.equal('mutationId' in backlogMessage.event, false);
    assert.equal('entityVersion' in backlogMessage.event, false);
    assertObject(backlogMessage.event.payload, 'public backlog payload');
    exactKeys(backlogMessage.event.payload, publicLogKeys);
    assert.equal(backlogMessage.event.payload.callsign, 'BA4BACK');
    assert.equal(backlogMessage.event.payload.time, '2026-07-12T12:34:56.000Z');

    const ready = await inbox.next();
    assert.deepEqual(ready, { type: 'ready', cursor: snapshotHead + 1 });
    const liveMutation = await createLog(sessionId, 'BA4LIVE', 'after ready');
    const liveMessage = await inbox.next();
    assert.equal(liveMessage.type, 'event');
    assertObject(liveMessage.event, 'public live event');
    exactKeys(liveMessage.event, publicEventKeys);
    assert.equal(liveMessage.event.seq, snapshotHead + 2);
    assert.equal(liveMessage.event.seq, liveMutation.event.seq);
    assertObject(liveMessage.event.payload, 'public live payload');
    exactKeys(liveMessage.event.payload, publicLogKeys);
    assert.equal(liveMessage.event.payload.callsign, 'BA4LIVE');
    assert.equal(liveMessage.event.payload.time, '2026-07-12T12:34:56.000Z');
    const wireText = JSON.stringify([backlogMessage, liveMessage]);
    for (const forbidden of [
      backlogMutation.mutationId,
      liveMutation.mutationId,
      actor('owner').id,
      sourceDeviceSentinel,
      'entityVersion',
      'mutationId',
      'actor',
    ]) {
      assert.equal(wireText.includes(forbidden), false, `public event leaked ${forbidden}`);
    }
    inbox.ws.close();
    await inbox.closed;
  });

  test('a malformed stored public backlog event closes only that socket with 1011', async () => {
    const sessionId = await createSession('Public malformed backlog isolation');
    const created = await createShare(sessionId);
    const exchanged = await exchange(created.share);
    const snapshot = success(await publicSnapshot(sessionId, exchanged.access.accessToken));
    const afterSeq = Number(snapshot.highWatermarkSeq);
    assert.equal(insertMalformedPublicBacklogEvent(sessionId), afterSeq + 1);
    const ticket = await publicTicket(sessionId, exchanged.access.accessToken, afterSeq);

    const ws = new WebSocket(
      `${wsBaseUrl}/ws/public?ticket=${encodeURIComponent(ticket.ticket)}`,
      { headers: { origin: 'https://public.example' } },
    );
    ws.on('error', () => undefined);
    const inbox = new WsInbox(ws);
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('malformed public backlog socket remained open')),
        3_000,
      );
      inbox.closed.then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, reject);
    });
    assert.equal(closed.code, 1011);
    assert.equal(
      inbox.queued.some((message) => message.type === 'event'),
      false,
      'server must never fall back to the unredacted stored event',
    );

    const serverInfo = success(await request('/api/v1/server-info'));
    assert.ok(Array.isArray(serverInfo.features), 'server must remain responsive after projection failure');
  });

  test('public WebSocket rejects missing or untrusted Origin without consuming the ticket', async () => {
    const sessionId = await createSession('Public WebSocket Origin boundary');
    const created = await createShare(sessionId);
    const exchanged = await exchange(created.share);
    const snapshot = success(await publicSnapshot(sessionId, exchanged.access.accessToken));
    const ticket = await publicTicket(
      sessionId,
      exchanged.access.accessToken,
      Number(snapshot.highWatermarkSeq),
    );
    const path = `/ws/public?ticket=${encodeURIComponent(ticket.ticket)}`;

    await rejectedWs(path, 403, {});
    await rejectedWs(path, 403, { origin: 'https://evil.example' });

    const inbox = await connectPublic(ticket.ticket);
    assert.equal((await inbox.next()).type, 'hello');
    assert.equal((await inbox.next()).type, 'ready');
    inbox.ws.close();
    await inbox.closed;
  });

  test('public WebSocket accepts the external HTTPS Origin through one trusted proxy hop', async () => {
    const sessionId = await createSession('Public WebSocket trusted proxy');
    const created = await createShare(sessionId);
    const exchanged = await exchange(created.share);
    const snapshot = success(await publicSnapshot(sessionId, exchanged.access.accessToken));
    const ticket = await publicTicket(
      sessionId,
      exchanged.access.accessToken,
      Number(snapshot.highWatermarkSeq),
    );
    const path = `/ws/public?ticket=${encodeURIComponent(ticket.ticket)}`;
    const proxyHeaders = {
      origin: 'https://radio.example',
      host: 'internal.example:3000',
      'x-forwarded-for': '203.0.113.10',
      'x-forwarded-host': 'radio.example',
      'x-forwarded-proto': 'https',
    };

    await rejectedWs(path, 403, { headers: proxyHeaders });
    assert.equal(
      Number(db.prepare(`
        SELECT COUNT(*) FROM public_ws_tickets
        WHERE public_share_id = ? AND consumed_at IS NULL
      `).pluck().get(created.share.publicShareId)),
      1,
      'Origin rejection must not consume the one-time ticket',
    );

    config.trustProxy = 1;
    try {
      const inbox = await connectPublic(ticket.ticket, proxyHeaders);
      assert.equal((await inbox.next()).type, 'hello');
      assert.equal((await inbox.next()).type, 'ready');
      inbox.ws.close();
      await inbox.closed;
    } finally {
      config.trustProxy = false;
    }
  });

  test('public tickets are single-use and cannot cross share, Session, or member WebSocket scope', async () => {
    const firstSession = await createSession('Public ticket first scope');
    const secondSession = await createSession('Public ticket second scope');
    const firstShare = await createShare(firstSession);
    const firstAccess = await exchange(firstShare.share);
    const firstSnapshot = success(
      await publicSnapshot(firstSession, firstAccess.access.accessToken),
    );

    assertError(
      await publicSnapshot(secondSession, firstAccess.access.accessToken),
      404,
      'NOT_FOUND',
    );
    assertError(
      await request(`/api/v1/public/sessions/${secondSession}/ws-ticket`, {
        method: 'POST',
        token: firstAccess.access.accessToken,
        body: { afterSeq: 0 },
      }),
      404,
      'NOT_FOUND',
    );

    const publicTicketResult = await publicTicket(
      firstSession,
      firstAccess.access.accessToken,
      Number(firstSnapshot.highWatermarkSeq),
    );
    await rejectedWs(
      `/ws/collaboration?ticket=${encodeURIComponent(publicTicketResult.ticket)}`,
    );
    const publicConnection = await connectPublic(publicTicketResult.ticket);
    assert.equal((await publicConnection.next()).type, 'hello');
    assert.equal((await publicConnection.next()).type, 'ready');
    publicConnection.ws.close();
    await publicConnection.closed;
    await rejectedWs(`/ws/public?ticket=${encodeURIComponent(publicTicketResult.ticket)}`);

    const memberTicketResponse = success(
      await request(`/api/v1/sessions/${firstSession}/ws-ticket`, {
        method: 'POST',
        actor: actor('owner'),
        body: { deviceId, afterSeq: Number(firstSnapshot.highWatermarkSeq) },
      }),
    );
    await rejectedWs(
      `/ws/public?ticket=${encodeURIComponent(String(memberTicketResponse.ticket))}`,
    );
  });

  test('public ticket issuance promptly cleans expiry and caps unconsumed tickets per share', async () => {
    const sessionId = await createSession('Public ticket storage boundary');
    const created = await createShare(sessionId);
    const firstAccess = await exchange(created.share);
    const snapshot = success(await publicSnapshot(sessionId, firstAccess.access.accessToken));
    const afterSeq = Number(snapshot.highWatermarkSeq);
    const expiredTicketId = insertRecentlyExpiredPublicTicket(created.share.publicShareId);

    const tickets: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      tickets.push((await publicTicket(sessionId, firstAccess.access.accessToken, afterSeq)).ticket);
    }
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) FROM public_ws_tickets WHERE id = ?').pluck().get(
        expiredTicketId,
      )),
      0,
      'a ticket expired one minute ago must be deleted on the next issuance',
    );

    const secondAccess = await exchange(created.share);
    for (let index = 0; index < 4; index += 1) {
      tickets.push((await publicTicket(sessionId, secondAccess.access.accessToken, afterSeq)).ticket);
    }
    assert.equal(tickets.length, maxUnconsumedPublicTicketsPerShare);
    assert.equal(
      Number(db.prepare(`
        SELECT COUNT(*) FROM public_ws_tickets
        WHERE public_share_id = ? AND consumed_at IS NULL AND expires_at > ?
      `).pluck().get(created.share.publicShareId, new Date().toISOString())),
      maxUnconsumedPublicTicketsPerShare,
    );

    const thirdAccess = await exchange(created.share);
    assertError(
      await request(`/api/v1/public/sessions/${sessionId}/ws-ticket`, {
        method: 'POST',
        token: thirdAccess.access.accessToken,
        body: { afterSeq },
      }),
      429,
      'PUBLIC_WS_TICKET_LIMIT_REACHED',
    );

    const inbox = await connectPublic(tickets[0]);
    assert.equal((await inbox.next()).type, 'hello');
    assert.equal((await inbox.next()).type, 'ready');
    inbox.ws.close();
    await inbox.closed;
    await publicTicket(sessionId, thirdAccess.access.accessToken, afterSeq);
    assert.equal(
      Number(db.prepare(`
        SELECT COUNT(*) FROM public_ws_tickets
        WHERE public_share_id = ? AND consumed_at IS NULL AND expires_at > ?
      `).pluck().get(created.share.publicShareId, new Date().toISOString())),
      maxUnconsumedPublicTicketsPerShare,
      'consuming one ticket must release one unconsumed-ticket slot',
    );
  });

  test('manual revocation immediately stops REST, exchange, pending tickets and an established public socket', async () => {
    const sessionId = await createSession('Public manual revocation');
    const created = await createShare(sessionId);
    const exchanged = await exchange(created.share);
    const snapshot = success(await publicSnapshot(sessionId, exchanged.access.accessToken));
    const liveTicket = await publicTicket(
      sessionId,
      exchanged.access.accessToken,
      Number(snapshot.highWatermarkSeq),
    );
    const pendingTicket = await publicTicket(
      sessionId,
      exchanged.access.accessToken,
      Number(snapshot.highWatermarkSeq),
    );
    const inbox = await connectPublic(liveTicket.ticket);
    assert.equal((await inbox.next()).type, 'hello');
    assert.equal((await inbox.next()).type, 'ready');

    const revokeMutationId = randomUUID();
    const revoked = await request(
      `/api/v1/sessions/${sessionId}/public-shares/${created.share.publicShareId}`,
      {
        method: 'DELETE',
        actor: actor('owner'),
        idempotencyKey: revokeMutationId,
      },
    );
    const revokedBody = success(revoked);
    assert.equal(revoked.headers.get('cache-control'), 'no-store');
    assertObject(revokedBody.publicShare, 'revoked publicShare');
    assert.equal(typeof revokedBody.publicShare.revokedAt, 'string');
    assert.equal(revokedBody.publicShare.revokedBy, actor('owner').id);

    const control = await inbox.next();
    assert.equal(control.type, 'accessRevoked');
    assert.equal(control.reason, 'PUBLIC_SHARE_REVOKED');
    const closed = await Promise.race([
      inbox.closed,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('revoked public socket remained open')), 3_000);
      }),
    ]);
    assert.ok(closed.code === 4003 || closed.code === 1000);

    assertError(
      await publicSnapshot(sessionId, exchanged.access.accessToken),
      401,
      'PUBLIC_ACCESS_INVALID',
    );
    const exchangeAfterRevoke = await request(
      `/api/v1/public-shares/${created.share.publicShareId}/exchange`,
      { method: 'POST', body: { secret: created.share.secret } },
    );
    assertError(exchangeAfterRevoke, 404, 'PUBLIC_SHARE_INVALID');
    await rejectedWs(`/ws/public?ticket=${encodeURIComponent(pendingTicket.ticket)}`);

    const revokeAudit = auditRows(sessionId, 'public_share.revoked');
    assert.equal(revokeAudit.length, 1);
    assert.equal(revokeAudit[0].mutation_id, revokeMutationId);
    assert.equal(revokeAudit[0].actor_user_id, actor('owner').id);
  });

  test('natural share expiry closes an established socket and invalidates public REST without a revoke write', async () => {
    const sessionId = await createSession('Public natural expiry');
    const share = insertShortLivedShare(sessionId, 3_000);
    const exchanged = await exchange(share);
    const snapshot = success(await publicSnapshot(sessionId, exchanged.access.accessToken));
    const ticket = await publicTicket(
      sessionId,
      exchanged.access.accessToken,
      Number(snapshot.highWatermarkSeq),
    );
    const inbox = await connectPublic(ticket.ticket);
    assert.equal((await inbox.next()).type, 'hello');
    assert.equal((await inbox.next()).type, 'ready');

    await Promise.race([
      inbox.closed,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('expired public socket remained open')), 6_000);
      }),
    ]);
    assertError(
      await publicSnapshot(sessionId, exchanged.access.accessToken),
      401,
      'PUBLIC_ACCESS_INVALID',
    );
    assertError(
      await request(`/api/v1/public-shares/${share.publicShareId}/exchange`, {
        method: 'POST',
        body: { secret: share.secret },
      }),
      404,
      'PUBLIC_SHARE_INVALID',
    );
    const row = db.prepare('SELECT revoked_at FROM public_shares WHERE id = ?').get(
      share.publicShareId,
    ) as { revoked_at: string | null };
    assert.equal(row.revoked_at, null, 'natural expiry must not be rewritten as manual revocation');
  });

  test('Session deletion sends the final redacted event, revokes public capability state, then closes the socket', async () => {
    const sessionId = await createSession('Public Session deletion');
    await mutateSession(sessionId, 'close');
    const created = await createShare(sessionId);
    const exchanged = await exchange(created.share);
    const snapshot = success(await publicSnapshot(sessionId, exchanged.access.accessToken));
    const ticket = await publicTicket(
      sessionId,
      exchanged.access.accessToken,
      Number(snapshot.highWatermarkSeq),
    );
    const inbox = await connectPublic(ticket.ticket);
    assert.equal((await inbox.next()).type, 'hello');
    assert.equal((await inbox.next()).type, 'ready');

    const deleted = await mutateSession(sessionId, 'delete');
    assertObject(deleted.event, 'member deletion event');
    const finalMessage = await inbox.next();
    assert.equal(finalMessage.type, 'event');
    assertObject(finalMessage.event, 'public deletion event');
    exactKeys(finalMessage.event, publicEventKeys);
    assert.equal(finalMessage.event.type, 'session.deleted');
    assert.equal(finalMessage.event.seq, deleted.event.seq);
    assert.equal('actor' in finalMessage.event, false);
    assert.equal('mutationId' in finalMessage.event, false);
    assert.equal('entityVersion' in finalMessage.event, false);
    assertObject(finalMessage.event.payload, 'public deletion payload');
    exactKeys(finalMessage.event.payload, publicSessionKeys);
    assert.equal(typeof finalMessage.event.payload.deletedAt, 'string');
    await Promise.race([
      inbox.closed,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('deleted Session public socket remained open')), 3_000);
      }),
    ]);

    assertError(
      await publicSnapshot(sessionId, exchanged.access.accessToken),
      401,
      'PUBLIC_ACCESS_INVALID',
    );
    assertError(
      await request(`/api/v1/public-shares/${created.share.publicShareId}/exchange`, {
        method: 'POST',
        body: { secret: created.share.secret },
      }),
      404,
      'PUBLIC_SHARE_INVALID',
    );
    const storedShare = db.prepare(`
      SELECT revoked_at, revoked_by FROM public_shares WHERE id = ?
    `).get(created.share.publicShareId) as { revoked_at: string | null; revoked_by: string | null };
    assert.equal(typeof storedShare.revoked_at, 'string');
    assert.equal(storedShare.revoked_by, actor('owner').id);
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) FROM public_ws_tickets WHERE public_share_id = ?').pluck().get(
        created.share.publicShareId,
      )),
      0,
    );
    const deletionAudit = auditRows(sessionId, 'session.deleted');
    assert.equal(deletionAudit.length, 1);
    const details = JSON.parse(deletionAudit[0].details_json) as JsonObject;
    assert.equal(details.revokedPublicShareCount, 1);
  });

  test('public-share audit insertion failure rolls create and revoke state plus idempotency back together', async () => {
    const sessionId = await createSession('Public audit rollback');
    const createMutationId = randomUUID();
    db.exec(`
      CREATE TEMP TRIGGER fail_public_share_create_audit
      BEFORE INSERT ON collaboration_audit_events
      WHEN NEW.action = 'public_share.created'
      BEGIN
        SELECT RAISE(ABORT, 'forced public share create audit failure');
      END;
    `);
    try {
      const failedCreate = await request(`/api/v1/sessions/${sessionId}/public-shares`, {
        method: 'POST',
        actor: actor('owner'),
        idempotencyKey: createMutationId,
        body: { expiresInHours: 24 },
      });
      assertError(failedCreate, 500, 'INTERNAL_ERROR');
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) FROM public_shares WHERE session_id = ?').pluck().get(
          sessionId,
        )),
        0,
      );
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
          createMutationId,
        )),
        0,
      );
      assert.equal(auditRows(sessionId, 'public_share.created').length, 0);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_public_share_create_audit');
    }

    const created = await createShare(sessionId, createMutationId);
    assert.equal(auditRows(sessionId, 'public_share.created').length, 1);
    const exchanged = await exchange(created.share);
    const revokeMutationId = randomUUID();
    db.exec(`
      CREATE TEMP TRIGGER fail_public_share_revoke_audit
      BEFORE INSERT ON collaboration_audit_events
      WHEN NEW.action = 'public_share.revoked'
      BEGIN
        SELECT RAISE(ABORT, 'forced public share revoke audit failure');
      END;
    `);
    try {
      const failedRevoke = await request(
        `/api/v1/sessions/${sessionId}/public-shares/${created.share.publicShareId}`,
        {
          method: 'DELETE',
          actor: actor('owner'),
          idempotencyKey: revokeMutationId,
        },
      );
      assertError(failedRevoke, 500, 'INTERNAL_ERROR');
      const share = db.prepare('SELECT revoked_at FROM public_shares WHERE id = ?').get(
        created.share.publicShareId,
      ) as { revoked_at: string | null };
      assert.equal(share.revoked_at, null);
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(
          revokeMutationId,
        )),
        0,
      );
      assert.equal(auditRows(sessionId, 'public_share.revoked').length, 0);
      success(await publicSnapshot(sessionId, exchanged.access.accessToken));
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_public_share_revoke_audit');
    }

    success(
      await request(
        `/api/v1/sessions/${sessionId}/public-shares/${created.share.publicShareId}`,
        {
          method: 'DELETE',
          actor: actor('owner'),
          idempotencyKey: revokeMutationId,
        },
      ),
    );
    assert.equal(auditRows(sessionId, 'public_share.revoked').length, 1);
  });

  test('public Liveshare advertises capability, rejects unknown fields and marks sensitive responses no-store', async () => {
    const serverInfo = success(await request('/api/v1/server-info'));
    assert.ok(Array.isArray(serverInfo.features));
    assert.ok(serverInfo.features.includes('publicLiveshare'));
    assert.ok(serverInfo.features.includes('publicLivesharePage'));

    const sessionId = await createSession('Public strict contract');
    assertError(
      await request(`/api/v1/sessions/${sessionId}/public-shares`, {
        method: 'POST',
        actor: actor('owner'),
        idempotencyKey: randomUUID(),
        body: { expiresInHours: 24, unexpected: true },
      }),
      422,
      'VALIDATION_FAILED',
    );
    const created = await createShare(sessionId);
    const badExchange = await request(
      `/api/v1/public-shares/${created.share.publicShareId}/exchange`,
      {
        method: 'POST',
        body: { secret: created.share.secret, unexpected: true },
      },
    );
    assertError(badExchange, 422, 'VALIDATION_FAILED');
    assert.equal(badExchange.headers.get('cache-control'), 'no-store');

    const exchanged = await exchange(created.share);
    const snapshotResult = await publicSnapshot(sessionId, exchanged.access.accessToken);
    const snapshot = success(snapshotResult);
    assert.equal(snapshotResult.headers.get('cache-control'), 'no-store');
    const badTicket = await request(`/api/v1/public/sessions/${sessionId}/ws-ticket`, {
      method: 'POST',
      token: exchanged.access.accessToken,
      body: { afterSeq: snapshot.highWatermarkSeq, unexpected: true },
    });
    assertError(badTicket, 422, 'VALIDATION_FAILED');
    assert.equal(badTicket.headers.get('cache-control'), 'no-store');

    db.prepare(`
      UPDATE server_settings SET public_share_hmac_fingerprint = ? WHERE id = 1
    `).run('0'.repeat(64));
    const degradedInfo = success(await request('/api/v1/server-info'));
    assert.equal(degradedInfo.features.includes('publicLiveshare'), false);
    assert.equal(degradedInfo.features.includes('publicLivesharePage'), false);
    assertError(
      await publicSnapshot(sessionId, exchanged.access.accessToken),
      503,
      'PUBLIC_SHARE_HMAC_KEY_CHANGED',
    );
    assertError(
      await request(`/api/v1/public-shares/${created.share.publicShareId}/exchange`, {
        method: 'POST',
        body: { secret: created.share.secret },
      }),
      503,
      'PUBLIC_SHARE_HMAC_KEY_CHANGED',
    );
    success(await request(`/api/v1/sessions/${sessionId}/public-shares`, {
      actor: actor('owner'),
    }));
  });
});
