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

interface EventFixture {
  sessionId: string;
  title: string;
  eventCount: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 180;
const DEFAULT_MINIMUM_EVENTS = 10_000;
const DEFAULT_MAX_SESSIONS = 100;
const FIXED_MAX_EVENTS = 25_000;

const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'retention-test-jwt-secret-f8b913c4-3d50-4588-8e75-55a6bf70f459',
  jwtIssuer: 'openlogtool-retention-test',
  bootstrapSecret: 'retention-bootstrap-secret-e1022a80-41ac-4e9f',
  inviteHmacKey: 'retention-invite-hmac-key-f6f54c46-5c9d-44dd-9f93',
  publicShareHmacKey: 'retention-public-share-key-831e06d1-5db0-4e1e-a2f8',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function exactKeys(value: JsonObject, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertError(result: HttpResult, status: number, code: string): void {
  assert.equal(result.status, status, result.text);
  assertObject(result.body.error, 'error');
  assert.equal(result.body.error.code, code, result.text);
}

function assertNoStore(result: HttpResult): void {
  assert.equal(result.headers.get('cache-control'), 'no-store');
}

async function withFrozenTime<T>(isoTimestamp: string, action: () => Promise<T>): Promise<T> {
  const NativeDate = globalThis.Date;
  const timestamp = NativeDate.parse(isoTimestamp);
  assert.ok(Number.isFinite(timestamp), `invalid frozen timestamp: ${isoTimestamp}`);

  class FrozenDate extends NativeDate {
    constructor(value?: string | number) {
      super(value === undefined ? timestamp : value);
    }

    static now(): number {
      return timestamp;
    }
  }

  globalThis.Date = FrozenDate as unknown as DateConstructor;
  try {
    return await action();
  } finally {
    globalThis.Date = NativeDate;
  }
}

describe('administrator Session event retention API', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;

  const adminId = 'retention-admin';
  const secondAdminId = 'retention-second-admin';
  const ownerId = 'retention-owner';
  const ordinaryUserId = 'retention-user';

  function accessToken(userId: string, claimedRole: 'admin' | 'user'): string {
    return jwt.sign(
      { type: 'access', role: claimedRole },
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

  function elevationToken(userId = adminId): string {
    return jwt.sign(
      { type: 'admin-elevation', authVersion: 1 },
      config.jwtSecret,
      {
        algorithm: 'HS256',
        subject: userId,
        jwtid: randomUUID(),
        issuer: config.jwtIssuer,
        audience: 'openlogtool-admin-elevation-v1',
        expiresIn: 300,
      },
    );
  }

  function pruneHeaders(mutationId: string, userId = adminId): Record<string, string> {
    return {
      'idempotency-key': mutationId,
      'x-admin-elevation': elevationToken(userId),
    };
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
        ...(options.body === undefined && options.rawBody === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.rawBody ?? (
        options.body === undefined ? undefined : JSON.stringify(options.body)
      ),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    assertObject(parsed, 'HTTP response');
    return { status: response.status, headers: response.headers, body: parsed, text };
  }

  function insertEventFixture(
    label: string,
    eventCount: number,
    occurredAt: (seq: number) => string,
  ): EventFixture {
    const sessionId = `retention-${label}-${randomUUID()}`;
    const title = `NEVER_EXPOSE_RETENTION_TITLE_${label}_${randomUUID()}`;
    const now = new Date().toISOString();
    const insertSession = db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at
      ) VALUES (?, ?, 'active', ?, 1, ?, 0, ?, ?)
    `);
    const insertMembership = db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'owner', 1, ?, ?)
    `);
    const insertEvent = db.prepare(`
      INSERT INTO session_events (
        id, session_id, seq, type, entity_type, entity_id, entity_version,
        mutation_id, actor_user_id, actor_device_id, payload_json, occurred_at
      ) VALUES (?, ?, ?, 'log.updated', 'log', ?, 1, NULL, ?, NULL, ?, ?)
    `);

    db.transaction(() => {
      insertSession.run(sessionId, title, ownerId, eventCount, now, now);
      insertMembership.run(randomUUID(), sessionId, ownerId, now, now);
      for (let seq = 1; seq <= eventCount; seq += 1) {
        const eventId = randomUUID();
        const eventTime = occurredAt(seq);
        const entityId = `${sessionId}:log`;
        const event = {
          protocolVersion: 1,
          eventId,
          sessionId,
          seq,
          type: 'log.updated',
          entityType: 'log',
          entityId,
          entityVersion: 1,
          mutationId: null,
          actor: {
            userId: ownerId,
            deviceId: null,
            displayName: 'retentionowner',
          },
          occurredAt: eventTime,
          payload: {
            syncId: entityId,
            sessionId,
            version: 1,
            time: eventTime,
            controller: 'BG0AAA',
            callsign: 'BA0AAA',
            rstSent: null,
            rstRcvd: null,
            qth: null,
            device: null,
            power: null,
            antenna: null,
            height: null,
            remarks: null,
            createdAt: eventTime,
            updatedAt: eventTime,
            deletedAt: null,
          },
        };
        insertEvent.run(
          eventId,
          sessionId,
          seq,
          entityId,
          ownerId,
          JSON.stringify(event),
          eventTime,
        );
      }
    }).immediate();

    return { sessionId, title, eventCount };
  }

  function retireFixture(...fixtures: EventFixture[]): void {
    const update = db.prepare(`
      UPDATE sessions SET min_retained_seq = event_seq WHERE id = ?
    `);
    db.transaction(() => {
      for (const fixture of fixtures) update.run(fixture.sessionId);
    }).immediate();
  }

  function sessionBounds(sessionId: string): { event_seq: number; min_retained_seq: number } {
    return db.prepare(`
      SELECT event_seq, min_retained_seq FROM sessions WHERE id = ?
    `).get(sessionId) as { event_seq: number; min_retained_seq: number };
  }

  function sessionEventSeqs(sessionId: string): number[] {
    const rows = db.prepare(`
      SELECT seq FROM session_events WHERE session_id = ? ORDER BY seq
    `).all(sessionId) as Array<{ seq: number }>;
    return rows.map((row) => Number(row.seq));
  }

  function countRows(table: string, where = '', parameters: unknown[] = []): number {
    const allowed = new Set([
      'admin_audit_events',
      'collaboration_audit_events',
      'logs',
      'processed_mutations',
      'session_events',
    ]);
    assert.ok(allowed.has(table), `unsupported count table ${table}`);
    const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table} ${where}`).get(
      ...parameters,
    ) as { total: number };
    return Number(row.total);
  }

  function assertRetentionResponse(
    result: HttpResult,
    expected: {
      operation: 'preview' | 'prune';
      evaluatedAt: string;
      retentionDays: number;
      minimumEventsPerSession: number;
      maxSessions: number;
      scannedSessionCount: number;
      affectedSessionCount: number;
      eventCount: number;
      hasMore: boolean;
      auditEventId: string | null;
    },
  ): void {
    assert.equal(result.status, 200, result.text);
    assertNoStore(result);
    exactKeys(result.body, [
      'operation',
      'evaluatedAt',
      'cutoffOccurredBefore',
      'policy',
      'scannedSessionCount',
      'affectedSessionCount',
      'eventCount',
      'hasMore',
      'auditEventId',
    ]);
    assert.equal(result.body.operation, expected.operation);
    assert.equal(result.body.evaluatedAt, expected.evaluatedAt);
    assert.equal(
      result.body.cutoffOccurredBefore,
      new Date(Date.parse(expected.evaluatedAt) - expected.retentionDays * DAY_MS).toISOString(),
    );
    assertObject(result.body.policy, 'retention policy');
    exactKeys(result.body.policy, [
      'retentionDays',
      'minimumEventsPerSession',
      'maxSessions',
      'maxEvents',
    ]);
    assert.deepEqual(result.body.policy, {
      retentionDays: expected.retentionDays,
      minimumEventsPerSession: expected.minimumEventsPerSession,
      maxSessions: expected.maxSessions,
      maxEvents: FIXED_MAX_EVENTS,
    });
    assert.equal(result.body.scannedSessionCount, expected.scannedSessionCount);
    assert.equal(result.body.affectedSessionCount, expected.affectedSessionCount);
    assert.equal(result.body.eventCount, expected.eventCount);
    assert.equal(result.body.hasMore, expected.hasMore);
    if (expected.auditEventId === null) {
      assert.equal(result.body.auditEventId, null);
    } else {
      assert.equal(result.body.auditEventId, expected.auditEventId);
    }
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-event-retention-'));
    const databasePath = join(directory, 'retention.db');
    db = openDatabase(databasePath);
    config.dbPath = databasePath;

    const now = new Date().toISOString();
    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'NEVER_EXPOSE_RETENTION_PASSWORD_HASH', ?, ?, ?)
    `);
    insertUser.run(adminId, 'retentionadmin', 'admin', now, now);
    insertUser.run(secondAdminId, 'retentionsecondadmin', 'admin', now, now);
    insertUser.run(ownerId, 'retentionowner', 'user', now, now);
    insertUser.run(ordinaryUserId, 'retentionuser', 'user', now, now);

    server = createServer(createApp({ db, config }));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

  test('requires a current administrator and applies strict bounded request contracts', async () => {
    const adminToken = accessToken(adminId, 'admin');
    const authCases: Array<[string, string | undefined, number, string]> = [
      ['missing token', undefined, 401, 'AUTH_REQUIRED'],
      ['ordinary account', accessToken(ordinaryUserId, 'user'), 403, 'ADMIN_REQUIRED'],
      [
        'stale admin claim for an ordinary account',
        accessToken(ordinaryUserId, 'admin'),
        403,
        'ADMIN_REQUIRED',
      ],
      ['missing account', accessToken('retention-missing-user', 'admin'), 401, 'TOKEN_INVALID'],
    ];
    for (const [label, token, status, code] of authCases) {
      const result = await request('/api/v1/admin/session-event-retention/preview', { token });
      assertError(result, status, code);
      assertNoStore(result);
      assert.ok(label);
    }

    const frozenAt = new Date().toISOString();
    const defaults = await withFrozenTime(frozenAt, () => request(
      '/api/v1/admin/session-event-retention/preview',
      { token: adminToken },
    ));
    assertRetentionResponse(defaults, {
      operation: 'preview',
      evaluatedAt: frozenAt,
      retentionDays: DEFAULT_RETENTION_DAYS,
      minimumEventsPerSession: DEFAULT_MINIMUM_EVENTS,
      maxSessions: DEFAULT_MAX_SESSIONS,
      scannedSessionCount: 0,
      affectedSessionCount: 0,
      eventCount: 0,
      hasMore: false,
      auditEventId: null,
    });

    const invalidQueries = [
      'unexpected=1',
      'maxEvents=25000',
      'retentionDays=30&retentionDays=31',
      'retentionDays=29',
      'retentionDays=3651',
      'retentionDays=30.5',
      'minimumEventsPerSession=999',
      'minimumEventsPerSession=1000001',
      'maxSessions=0',
      'maxSessions=101',
    ];
    for (const query of invalidQueries) {
      const result = await request(
        `/api/v1/admin/session-event-retention/preview?${query}`,
        { token: adminToken },
      );
      assertError(result, 422, 'VALIDATION_FAILED');
      assertNoStore(result);
    }

    const missingIdempotency = await request('/api/v1/admin/session-event-retention/prune', {
      method: 'POST',
      token: adminToken,
      body: { reason: 'Validate idempotency requirement' },
    });
    assertError(missingIdempotency, 400, 'IDEMPOTENCY_KEY_REQUIRED');
    assertNoStore(missingIdempotency);

    const invalidBodies: unknown[] = [
      [],
      { unexpected: true },
      { maxEvents: FIXED_MAX_EVENTS },
      { retentionDays: 29 },
      { retentionDays: 3651 },
      { retentionDays: 30.5 },
      { retentionDays: '30' },
      { minimumEventsPerSession: 999 },
      { minimumEventsPerSession: 1_000_001 },
      { maxSessions: 0 },
      { maxSessions: 101 },
    ];
    for (const body of invalidBodies) {
      const result = await request('/api/v1/admin/session-event-retention/prune', {
        method: 'POST',
        token: adminToken,
        body,
        headers: { 'idempotency-key': randomUUID() },
      });
      assertError(result, 422, 'VALIDATION_FAILED');
      assertNoStore(result);
    }

    const nullBody = await request('/api/v1/admin/session-event-retention/prune', {
      method: 'POST',
      token: adminToken,
      body: null,
      headers: { 'idempotency-key': randomUUID() },
    });
    assertError(nullBody, 400, 'INVALID_JSON');
    assertNoStore(nullBody);

    const queryOnWrite = await request(
      '/api/v1/admin/session-event-retention/prune?retentionDays=30',
      {
        method: 'POST',
        token: adminToken,
        body: {},
        headers: { 'idempotency-key': randomUUID() },
      },
    );
    assertError(queryOnWrite, 422, 'VALIDATION_FAILED');
  });

  test('preview is read-only, aggregate-only, bounded by maxSessions and reports more work', async () => {
    const frozenAt = new Date().toISOString();
    const cutoff = new Date(Date.parse(frozenAt) - 30 * DAY_MS);
    const oldTime = new Date(cutoff.getTime() - DAY_MS).toISOString();
    const first = insertEventFixture('preview-a', 1_001, () => oldTime);
    const second = insertEventFixture('preview-b', 1_001, () => oldTime);
    const changesBefore = db.prepare('SELECT total_changes() AS value').pluck().get() as number;
    const auditBefore = countRows(
      'admin_audit_events',
      "WHERE action = 'session_events.pruned'",
    );
    const mutationsBefore = countRows('processed_mutations');

    try {
      const result = await withFrozenTime(frozenAt, () => request(
        '/api/v1/admin/session-event-retention/preview'
          + '?retentionDays=30&minimumEventsPerSession=1000&maxSessions=1',
        { token: accessToken(adminId, 'admin') },
      ));
      assertRetentionResponse(result, {
        operation: 'preview',
        evaluatedAt: frozenAt,
        retentionDays: 30,
        minimumEventsPerSession: 1_000,
        maxSessions: 1,
        scannedSessionCount: 1,
        affectedSessionCount: 1,
        eventCount: 1,
        hasMore: true,
        auditEventId: null,
      });
      const serialized = result.text;
      for (const secret of [first.sessionId, first.title, second.sessionId, second.title, ownerId]) {
        assert.equal(serialized.includes(secret), false, `preview leaked ${secret}`);
      }
      assert.equal(
        db.prepare('SELECT total_changes() AS value').pluck().get(),
        changesBefore,
        'preview must perform zero SQLite writes',
      );
      assert.equal(countRows('processed_mutations'), mutationsBefore);
      assert.equal(
        countRows('admin_audit_events', "WHERE action = 'session_events.pruned'"),
        auditBefore,
      );
      assert.deepEqual(sessionBounds(first.sessionId), {
        event_seq: 1_001,
        min_retained_seq: 0,
      });
      assert.equal(sessionEventSeqs(first.sessionId).length, 1_001);
    } finally {
      retireFixture(first, second);
    }
  });

  test('the fixed event budget truncates one Session and a later run continues contiguously', async () => {
    const frozenAt = new Date().toISOString();
    const cutoff = new Date(Date.parse(frozenAt) - 30 * DAY_MS);
    const oldTime = new Date(cutoff.getTime() - DAY_MS).toISOString();
    const fixture = insertEventFixture(
      'budget-continuation',
      FIXED_MAX_EVENTS + 1_002,
      () => oldTime,
    );

    try {
      const first = await withFrozenTime(frozenAt, () => request(
        '/api/v1/admin/session-event-retention/prune',
        {
          method: 'POST',
          token: accessToken(adminId, 'admin'),
          headers: pruneHeaders(randomUUID()),
          body: {
            retentionDays: 30,
            minimumEventsPerSession: 1_000,
            maxSessions: 100,
            reason: 'Continue retention budget test',
          },
        },
      ));
      assertRetentionResponse(first, {
        operation: 'prune',
        evaluatedAt: frozenAt,
        retentionDays: 30,
        minimumEventsPerSession: 1_000,
        maxSessions: 100,
        scannedSessionCount: 1,
        affectedSessionCount: 1,
        eventCount: FIXED_MAX_EVENTS,
        hasMore: true,
        auditEventId: String(first.body.auditEventId),
      });
      assert.deepEqual(sessionBounds(fixture.sessionId), {
        event_seq: FIXED_MAX_EVENTS + 1_002,
        min_retained_seq: FIXED_MAX_EVENTS,
      });
      assert.equal(sessionEventSeqs(fixture.sessionId).at(0), FIXED_MAX_EVENTS + 1);
      assert.equal(sessionEventSeqs(fixture.sessionId).length, 1_002);

      const second = await withFrozenTime(frozenAt, () => request(
        '/api/v1/admin/session-event-retention/prune',
        {
          method: 'POST',
          token: accessToken(adminId, 'admin'),
          headers: pruneHeaders(randomUUID()),
          body: {
            retentionDays: 30,
            minimumEventsPerSession: 1_000,
            maxSessions: 100,
            reason: 'Continue retention budget test',
          },
        },
      ));
      assertRetentionResponse(second, {
        operation: 'prune',
        evaluatedAt: frozenAt,
        retentionDays: 30,
        minimumEventsPerSession: 1_000,
        maxSessions: 100,
        scannedSessionCount: 1,
        affectedSessionCount: 1,
        eventCount: 2,
        hasMore: false,
        auditEventId: String(second.body.auditEventId),
      });
      assert.deepEqual(sessionBounds(fixture.sessionId), {
        event_seq: FIXED_MAX_EVENTS + 1_002,
        min_retained_seq: FIXED_MAX_EVENTS + 2,
      });
      assert.equal(sessionEventSeqs(fixture.sessionId).at(0), FIXED_MAX_EVENTS + 3);
      assert.equal(sessionEventSeqs(fixture.sessionId).length, 1_000);
    } finally {
      retireFixture(fixture);
    }
  });

  test('prune preserves the newest floor, advances M exactly, and stops at cutoff or newer barriers', async () => {
    const frozenAt = new Date().toISOString();
    const cutoff = new Date(Date.parse(frozenAt) - 30 * DAY_MS);
    const oldTime = new Date(cutoff.getTime() - DAY_MS).toISOString();
    const recentTime = new Date(cutoff.getTime() + DAY_MS).toISOString();
    const cutoffTime = cutoff.toISOString();

    // H=1005 and K=1000 is the hard-limit-compatible equivalent of the small H=10/K=3
    // boundary example: exactly H-K=5 events may disappear and M becomes 5.
    const floor = insertEventFixture('floor', 1_005, () => oldTime);
    const exactCutoff = insertEventFixture('exact-cutoff', 1_003, (seq) => {
      if (seq === 1 || seq === 3) return oldTime;
      if (seq === 2) return cutoffTime;
      return recentTime;
    });
    const newerBarrier = insertEventFixture('newer-barrier', 1_003, (seq) => {
      if (seq === 1 || seq === 3) return oldTime;
      return recentTime;
    });

    const sentinelMutationId = `retention-sentinel-${randomUUID()}`;
    const sentinelAdminAuditId = randomUUID();
    const sentinelCollaborationAuditId = randomUUID();
    const sentinelLogId = randomUUID();
    db.prepare(`
      INSERT INTO processed_mutations (
        mutation_id, session_id, user_id, request_hash, status_code, response_json, created_at
      ) VALUES (?, ?, ?, 'RETENTION_SENTINEL_HASH', 200, '{"sentinel":true}', ?)
    `).run(sentinelMutationId, floor.sessionId, ownerId, frozenAt);
    db.prepare(`
      INSERT INTO admin_audit_events (
        id, action, actor_user_id, target_user_id, request_id, mutation_id,
        before_json, after_json, details_json, occurred_at
      ) VALUES (
        ?, 'settings.registration.updated', ?, NULL, ?, ?,
        '{"registrationEnabled":false}', '{"registrationEnabled":true}', '{}', ?
      )
    `).run(
      sentinelAdminAuditId,
      adminId,
      randomUUID(),
      `retention-admin-audit-${randomUUID()}`,
      frozenAt,
    );
    db.prepare(`
      INSERT INTO collaboration_audit_events (
        id, session_id, action, actor_user_id, target_user_id, request_id, mutation_id,
        before_json, after_json, details_json, occurred_at
      ) VALUES (
        ?, ?, 'invite.created', ?, NULL, ?, ?, NULL,
        '{"inviteId":"retention-sentinel","role":"viewer","maxUses":1,"usedCount":0,"expiresAt":"2099-01-01T00:00:00.000Z"}',
        '{}', ?
      )
    `).run(
      sentinelCollaborationAuditId,
      floor.sessionId,
      ownerId,
      randomUUID(),
      `retention-collaboration-audit-${randomUUID()}`,
      frozenAt,
    );
    db.prepare(`
      INSERT INTO logs (
        sync_id, session_id, controller, callsign, time, created_at, updated_at
      ) VALUES (?, ?, 'BG0AAA', 'BA0AAA', ?, ?, ?)
    `).run(sentinelLogId, floor.sessionId, frozenAt, frozenAt, frozenAt);

    const beforeCounts = {
      processed: countRows('processed_mutations'),
      adminAudit: countRows('admin_audit_events'),
      collaborationAudit: countRows('collaboration_audit_events'),
      logs: countRows('logs'),
    };
    const mutationId = `retention-prune-${randomUUID()}`;
    let result: HttpResult;

    try {
      result = await withFrozenTime(frozenAt, () => request(
        '/api/v1/admin/session-event-retention/prune',
        {
          method: 'POST',
          token: accessToken(adminId, 'admin'),
          headers: pruneHeaders(mutationId),
          body: {
            retentionDays: 30,
            minimumEventsPerSession: 1_000,
            maxSessions: 100,
            reason: 'Apply bounded Session event retention',
          },
        },
      ));
      assert.equal(typeof result.body.auditEventId, 'string', result.text);
      assertRetentionResponse(result, {
        operation: 'prune',
        evaluatedAt: frozenAt,
        retentionDays: 30,
        minimumEventsPerSession: 1_000,
        maxSessions: 100,
        scannedSessionCount: 3,
        affectedSessionCount: 3,
        eventCount: 7,
        hasMore: false,
        auditEventId: String(result.body.auditEventId),
      });

      assert.deepEqual(sessionBounds(floor.sessionId), {
        event_seq: 1_005,
        min_retained_seq: 5,
      });
      assert.deepEqual(sessionEventSeqs(floor.sessionId),
        Array.from({ length: 1_000 }, (_, index) => index + 6));
      assert.deepEqual(sessionBounds(exactCutoff.sessionId), {
        event_seq: 1_003,
        min_retained_seq: 1,
      });
      assert.deepEqual(sessionEventSeqs(exactCutoff.sessionId).slice(0, 3), [2, 3, 4]);
      assert.deepEqual(sessionBounds(newerBarrier.sessionId), {
        event_seq: 1_003,
        min_retained_seq: 1,
      });
      assert.deepEqual(sessionEventSeqs(newerBarrier.sessionId).slice(0, 3), [2, 3, 4]);

      const expired = await request(
        `/api/v1/sessions/${floor.sessionId}/events?afterSeq=4&limit=1`,
        { token: accessToken(ownerId, 'user') },
      );
      assertError(expired, 410, 'CURSOR_EXPIRED');
      assertObject(expired.body.error.details, 'CURSOR_EXPIRED details');
      assert.equal(expired.body.error.details.minAvailableSeq, 5);
      const boundary = await request(
        `/api/v1/sessions/${floor.sessionId}/events?afterSeq=5&limit=1`,
        { token: accessToken(ownerId, 'user') },
      );
      assert.equal(boundary.status, 200, boundary.text);
      assert.ok(Array.isArray(boundary.body.events));
      assert.equal(boundary.body.events.length, 1);
      assertObject(boundary.body.events[0], 'first retained event');
      assert.equal(boundary.body.events[0].seq, 6);

      assert.equal(countRows('logs'), beforeCounts.logs, 'Log rows must not be retained-event GC targets');
      assert.equal(
        countRows('collaboration_audit_events'),
        beforeCounts.collaborationAudit,
        'collaboration audit is an independent append-only stream',
      );
      assert.equal(
        countRows('processed_mutations', 'WHERE mutation_id = ?', [sentinelMutationId]),
        1,
        'event pruning must not clean existing idempotency results',
      );
      assert.equal(countRows('logs', 'WHERE sync_id = ?', [sentinelLogId]), 1);
      assert.equal(
        countRows('admin_audit_events', 'WHERE id = ?', [sentinelAdminAuditId]),
        1,
      );
      assert.equal(
        countRows('collaboration_audit_events', 'WHERE id = ?', [sentinelCollaborationAuditId]),
        1,
      );
      assert.equal(countRows('processed_mutations'), beforeCounts.processed + 1);
      assert.equal(countRows('admin_audit_events'), beforeCounts.adminAudit + 1);

      const audit = db.prepare(`
        SELECT * FROM admin_audit_events WHERE id = ?
      `).get(String(result.body.auditEventId)) as {
        action: string;
        actor_user_id: string;
        target_user_id: string | null;
        mutation_id: string;
        before_json: string | null;
        after_json: string;
        details_json: string;
        occurred_at: string;
      };
      assert.equal(audit.action, 'session_events.pruned');
      assert.equal(audit.actor_user_id, adminId);
      assert.equal(audit.target_user_id, null);
      assert.equal(audit.mutation_id, mutationId);
      assert.equal(audit.before_json, null);
      assert.deepEqual(JSON.parse(audit.after_json), {
        eventCount: 7,
        affectedSessionCount: 3,
      });
      assert.deepEqual(JSON.parse(audit.details_json), {
        evaluatedAt: frozenAt,
        cutoffOccurredBefore: cutoffTime,
        retentionDays: 30,
        minimumEventsPerSession: 1_000,
        maxSessions: 100,
        maxEvents: FIXED_MAX_EVENTS,
        scannedSessionCount: 3,
        hasMore: false,
      });
      assert.equal(audit.occurred_at, frozenAt);

      const writesAfterFirst = db.prepare('SELECT total_changes() AS value').pluck().get();
      const replay = await request('/api/v1/admin/session-event-retention/prune', {
        method: 'POST',
        token: accessToken(adminId, 'admin'),
        headers: pruneHeaders(mutationId),
        body: {
          retentionDays: 30,
          minimumEventsPerSession: 1_000,
          maxSessions: 100,
          reason: 'Apply bounded Session event retention',
        },
      });
      assert.equal(replay.status, 200, replay.text);
      assert.deepEqual(replay.body, result.body);
      assert.equal(replay.headers.get('idempotent-replay'), 'true');
      assert.equal(
        db.prepare('SELECT total_changes() AS value').pluck().get(),
        writesAfterFirst,
        'an exact replay must perform zero writes',
      );

      const reused = await request('/api/v1/admin/session-event-retention/prune', {
        method: 'POST',
        token: accessToken(adminId, 'admin'),
        headers: pruneHeaders(mutationId),
        body: {
          retentionDays: 31,
          minimumEventsPerSession: 1_000,
          maxSessions: 100,
          reason: 'Apply bounded Session event retention',
        },
      });
      assertError(reused, 409, 'MUTATION_ID_REUSED');

      const crossActor = await request('/api/v1/admin/session-event-retention/prune', {
        method: 'POST',
        token: accessToken(secondAdminId, 'admin'),
        headers: pruneHeaders(mutationId, secondAdminId),
        body: {
          retentionDays: 30,
          minimumEventsPerSession: 1_000,
          maxSessions: 100,
          reason: 'Apply bounded Session event retention',
        },
      });
      assertError(crossActor, 409, 'MUTATION_ID_REUSED');
    } finally {
      retireFixture(floor, exactCutoff, newerBarrier);
    }
  });

  test('an invalid stored occurredAt fails safe and blocks later old events', async () => {
    const frozenAt = new Date().toISOString();
    const cutoff = new Date(Date.parse(frozenAt) - 30 * DAY_MS);
    const oldTime = new Date(cutoff.getTime() - DAY_MS).toISOString();
    const recentTime = new Date(cutoff.getTime() + DAY_MS).toISOString();
    const fixture = insertEventFixture('invalid-time', 1_003, (seq) => {
      if (seq === 1 || seq === 3) return oldTime;
      if (seq === 2) return '0000-NOT-A-CANONICAL-TIMESTAMP';
      return recentTime;
    });

    try {
      const result = await withFrozenTime(frozenAt, () => request(
        '/api/v1/admin/session-event-retention/prune',
        {
          method: 'POST',
          token: accessToken(adminId, 'admin'),
          headers: pruneHeaders(randomUUID()),
          body: {
            retentionDays: 30,
            minimumEventsPerSession: 1_000,
            maxSessions: 100,
            reason: 'Validate malformed retention timestamp',
          },
        },
      ));
      assertRetentionResponse(result, {
        operation: 'prune',
        evaluatedAt: frozenAt,
        retentionDays: 30,
        minimumEventsPerSession: 1_000,
        maxSessions: 100,
        scannedSessionCount: 1,
        affectedSessionCount: 1,
        eventCount: 1,
        hasMore: false,
        auditEventId: String(result.body.auditEventId),
      });
      assert.deepEqual(sessionBounds(fixture.sessionId), {
        event_seq: 1_003,
        min_retained_seq: 1,
      });
      assert.deepEqual(sessionEventSeqs(fixture.sessionId).slice(0, 3), [2, 3, 4]);
      assert.equal(
        db.prepare(`
          SELECT occurred_at FROM session_events WHERE session_id = ? AND seq = 2
        `).pluck().get(fixture.sessionId),
        '0000-NOT-A-CANONICAL-TIMESTAMP',
      );
    } finally {
      retireFixture(fixture);
    }
  });

  test('a SQLite-parseable but non-canonical calendar time is an unsafe retention barrier', async () => {
    const frozenAt = new Date().toISOString();
    const cutoff = new Date(Date.parse(frozenAt) - 30 * DAY_MS);
    const oldTime = new Date(cutoff.getTime() - DAY_MS).toISOString();
    const recentTime = new Date(cutoff.getTime() + DAY_MS).toISOString();
    const impossibleDate = '2023-02-30T00:00:00.000Z';
    const fixture = insertEventFixture('noncanonical-time', 1_002, (seq) => {
      if (seq === 1) return impossibleDate;
      if (seq === 2) return oldTime;
      return recentTime;
    });

    try {
      const result = await withFrozenTime(frozenAt, () => request(
        '/api/v1/admin/session-event-retention/prune',
        {
          method: 'POST',
          token: accessToken(adminId, 'admin'),
          headers: pruneHeaders(randomUUID()),
          body: {
            retentionDays: 30,
            minimumEventsPerSession: 1_000,
            maxSessions: 100,
            reason: 'Validate noncanonical retention timestamp',
          },
        },
      ));
      assertRetentionResponse(result, {
        operation: 'prune',
        evaluatedAt: frozenAt,
        retentionDays: 30,
        minimumEventsPerSession: 1_000,
        maxSessions: 100,
        scannedSessionCount: 0,
        affectedSessionCount: 0,
        eventCount: 0,
        hasMore: false,
        auditEventId: null,
      });
      assert.deepEqual(sessionBounds(fixture.sessionId), {
        event_seq: 1_002,
        min_retained_seq: 0,
      });
      assert.equal(
        db.prepare(`
          SELECT occurred_at FROM session_events WHERE session_id = ? AND seq = 1
        `).pluck().get(fixture.sessionId),
        impossibleDate,
      );
    } finally {
      retireFixture(fixture);
    }
  });

  test('a missing first retained event fails closed without cursor, audit or replay writes', async () => {
    const frozenAt = new Date().toISOString();
    const cutoff = new Date(Date.parse(frozenAt) - 30 * DAY_MS);
    const oldTime = new Date(cutoff.getTime() - DAY_MS).toISOString();
    const fixture = insertEventFixture('missing-first-event', 1_001, () => oldTime);
    const mutationId = `retention-gap-${randomUUID()}`;
    db.prepare(`
      DELETE FROM session_events WHERE session_id = ? AND seq = 1
    `).run(fixture.sessionId);
    const auditBefore = countRows(
      'admin_audit_events',
      "WHERE action = 'session_events.pruned'",
    );

    try {
      const result = await withFrozenTime(frozenAt, () => request(
        '/api/v1/admin/session-event-retention/prune',
        {
          method: 'POST',
          token: accessToken(adminId, 'admin'),
          headers: pruneHeaders(mutationId),
          body: {
            retentionDays: 30,
            minimumEventsPerSession: 1_000,
            maxSessions: 100,
            reason: 'Validate event history integrity',
          },
        },
      ));
      assertError(result, 500, 'EVENT_RETENTION_INTEGRITY_FAILED');
      assertNoStore(result);
      assert.deepEqual(sessionBounds(fixture.sessionId), {
        event_seq: 1_001,
        min_retained_seq: 0,
      });
      assert.equal(sessionEventSeqs(fixture.sessionId).at(0), 2);
      assert.equal(
        countRows('admin_audit_events', "WHERE action = 'session_events.pruned'"),
        auditBefore,
      );
      assert.equal(
        countRows('processed_mutations', 'WHERE mutation_id = ?', [mutationId]),
        0,
      );
    } finally {
      retireFixture(fixture);
    }
  });

  test('an audit insertion failure rolls pruning, M advancement and idempotency back together', async () => {
    const frozenAt = new Date().toISOString();
    const cutoff = new Date(Date.parse(frozenAt) - 30 * DAY_MS);
    const oldTime = new Date(cutoff.getTime() - DAY_MS).toISOString();
    const fixture = insertEventFixture('audit-rollback', 1_001, () => oldTime);
    const mutationId = `retention-rollback-${randomUUID()}`;
    const beforeEventIds = db.prepare(`
      SELECT id FROM session_events WHERE session_id = ? ORDER BY seq
    `).pluck().all(fixture.sessionId);
    const auditBefore = countRows(
      'admin_audit_events',
      "WHERE action = 'session_events.pruned'",
    );

    db.exec(`
      CREATE TEMP TRIGGER fail_retention_admin_audit_insert
      BEFORE INSERT ON admin_audit_events
      WHEN NEW.action = 'session_events.pruned'
      BEGIN
        SELECT RAISE(ABORT, 'forced retention audit failure');
      END;
    `);
    try {
      const result = await withFrozenTime(frozenAt, () => request(
        '/api/v1/admin/session-event-retention/prune',
        {
          method: 'POST',
          token: accessToken(adminId, 'admin'),
          headers: pruneHeaders(mutationId),
          body: {
            retentionDays: 30,
            minimumEventsPerSession: 1_000,
            maxSessions: 100,
            reason: 'Validate retention transaction rollback',
          },
        },
      ));
      assertError(result, 500, 'INTERNAL_ERROR');
      assertNoStore(result);
      assert.deepEqual(sessionBounds(fixture.sessionId), {
        event_seq: 1_001,
        min_retained_seq: 0,
      });
      assert.deepEqual(
        db.prepare(`
          SELECT id FROM session_events WHERE session_id = ? ORDER BY seq
        `).pluck().all(fixture.sessionId),
        beforeEventIds,
      );
      assert.equal(
        countRows('admin_audit_events', "WHERE action = 'session_events.pruned'"),
        auditBefore,
      );
      assert.equal(
        countRows('processed_mutations', 'WHERE mutation_id = ?', [mutationId]),
        0,
      );
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_retention_admin_audit_insert');
      retireFixture(fixture);
    }
  });
});
