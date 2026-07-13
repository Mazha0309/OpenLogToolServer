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

type JsonObject = Record<string, any>;

const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'log-authorship-test-jwt-secret-bb022387-cc7b-4998-b95b-27f37353',
  jwtIssuer: 'openlogtool-log-authorship-test',
  bootstrapSecret: 'log-authorship-bootstrap-secret-bb022387',
  inviteHmacKey: 'log-authorship-invite-key-bb022387-cc7b-4998-b95b',
  publicShareHmacKey: 'log-authorship-public-key-bb022387-cc7b-4998-b95b',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

const ids = {
  owner: 'authorship-owner',
  editor: 'authorship-editor',
  viewer: 'authorship-viewer',
  admin: 'authorship-admin',
  session: 'authorship-session',
};

const deviceIds = {
  owner: '11111111-1111-4111-8111-111111111111',
  editor: '22222222-2222-4222-8222-222222222222',
  viewer: '33333333-3333-4333-8333-333333333333',
};

interface HttpResult {
  status: number;
  body: JsonObject;
  text: string;
}

describe('v1 Log authorship authorization', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;

  function token(userId: string, role: 'user' | 'admin' = 'user'): string {
    return jwt.sign(
      { type: 'access', role, av: 1 },
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

  async function request(
    path: string,
    options: {
      method?: string;
      userId: string;
      role?: 'user' | 'admin';
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token(options.userId, options.role)}`,
        'x-request-id': randomUUID(),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) as JsonObject : {},
      text,
    };
  }

  async function mutate(
    actor: 'owner' | 'editor' | 'viewer',
    input: {
      syncId: string;
      operation: 'create' | 'update' | 'delete' | 'restore';
      baseVersion: number;
      value?: JsonObject;
      patch?: JsonObject;
      confirm?: boolean;
    },
  ): Promise<JsonObject> {
    const mutationId = randomUUID();
    const response = await request(`/api/v1/sessions/${ids.session}/mutations`, {
      method: 'POST',
      userId: ids[actor],
      body: {
        protocolVersion: 1,
        deviceId: deviceIds[actor],
        operations: [{
          mutationId,
          entityType: 'log',
          entityId: input.syncId,
          operation: input.operation,
          baseVersion: input.baseVersion,
          ...(input.value === undefined ? {} : { value: input.value }),
          ...(input.patch === undefined ? {} : { patch: input.patch }),
          ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
        }],
      },
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.results.length, 1, response.text);
    return response.body.results[0];
  }

  function createValue(callsign: string): JsonObject {
    return {
      time: '2026-07-13T12:00:00.000Z',
      controller: 'BA0CTRL',
      callsign,
      rstSent: '59',
      rstRcvd: '58',
      remarks: 'created through member mutation',
    };
  }

  function storedLog(syncId: string): JsonObject {
    return db.prepare(`
      SELECT * FROM logs WHERE session_id = ? AND sync_id = ?
    `).get(ids.session, syncId) as JsonObject;
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-log-authorship-'));
    db = openDatabase(join(directory, 'authorship.db'));
    const now = new Date().toISOString();
    const insertUser = db.prepare(`
      INSERT INTO users (
        id, username, password_hash, role, created_at, updated_at,
        password_changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [name, userId] of Object.entries(ids)) {
      if (name === 'session') continue;
      insertUser.run(
        userId,
        userId,
        bcrypt.hashSync(`${name}-password-123!`, 10),
        name === 'admin' ? 'admin' : 'user',
        now,
        now,
        now,
      );
    }
    db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at
      ) VALUES (?, 'Authorship Net', 'active', ?, 1, 0, 0, ?, ?)
    `).run(ids.session, ids.owner, now, now);
    const insertMembership = db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
    `);
    insertMembership.run(randomUUID(), ids.session, ids.owner, 'owner', now, now);
    insertMembership.run(randomUUID(), ids.session, ids.editor, 'editor', now, now);
    insertMembership.run(randomUUID(), ids.session, ids.viewer, 'viewer', now, now);

    const app = createApp({ db, config });
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

  test('every member-created Log records its authenticated author', async () => {
    const ownerCreated = await mutate('owner', {
      syncId: 'owner-log',
      operation: 'create',
      baseVersion: 0,
      value: createValue('BA1OWN'),
    });
    assert.equal(ownerCreated.status, 'accepted');
    assert.equal(storedLog('owner-log').created_by, ids.owner);
    assert.equal(storedLog('owner-log').updated_by, ids.owner);

    const editorCreated = await mutate('editor', {
      syncId: 'editor-log',
      operation: 'create',
      baseVersion: 0,
      value: createValue('BA2EDIT'),
    });
    assert.equal(editorCreated.status, 'accepted');
    assert.equal(storedLog('editor-log').created_by, ids.editor);
    assert.equal(storedLog('editor-log').updated_by, ids.editor);
  });

  test('Owner and Editor cannot update, delete or restore another member’s Log', async () => {
    const eventCountBefore = Number(db.prepare(
      'SELECT COUNT(*) FROM session_events WHERE session_id = ?',
    ).pluck().get(ids.session));

    const ownerUpdate = await mutate('owner', {
      syncId: 'editor-log',
      operation: 'update',
      baseVersion: 1,
      patch: { remarks: 'owner must not overwrite editor' },
    });
    assert.equal(ownerUpdate.status, 'rejected');
    assert.equal(ownerUpdate.code, 'LOG_AUTHOR_REQUIRED');

    const editorDelete = await mutate('editor', {
      syncId: 'owner-log',
      operation: 'delete',
      baseVersion: 1,
    });
    assert.equal(editorDelete.status, 'rejected');
    assert.equal(editorDelete.code, 'LOG_AUTHOR_REQUIRED');

    assert.equal(storedLog('editor-log').version, 1);
    assert.equal(storedLog('editor-log').remarks, 'created through member mutation');
    assert.equal(storedLog('owner-log').version, 1);
    assert.equal(storedLog('owner-log').deleted_at, null);
    assert.equal(
      Number(db.prepare(
        'SELECT COUNT(*) FROM session_events WHERE session_id = ?',
      ).pluck().get(ids.session)),
      eventCountBefore,
      'rejected authorship mutations must not append collaboration events',
    );
  });

  test('the author can update, delete and restore their own Log while Viewer stays read-only', async () => {
    const updated = await mutate('editor', {
      syncId: 'editor-log',
      operation: 'update',
      baseVersion: 1,
      patch: { remarks: 'editor correction' },
    });
    assert.equal(updated.status, 'accepted');
    assert.equal(storedLog('editor-log').version, 2);
    assert.equal(storedLog('editor-log').updated_by, ids.editor);

    const deleted = await mutate('editor', {
      syncId: 'editor-log',
      operation: 'delete',
      baseVersion: 2,
    });
    assert.equal(deleted.status, 'accepted');
    assert.equal(storedLog('editor-log').version, 3);
    assert.equal(storedLog('editor-log').deleted_by, ids.editor);

    const ownerRestore = await mutate('owner', {
      syncId: 'editor-log',
      operation: 'restore',
      baseVersion: 3,
      confirm: true,
    });
    assert.equal(ownerRestore.status, 'rejected');
    assert.equal(ownerRestore.code, 'LOG_AUTHOR_REQUIRED');

    const restored = await mutate('editor', {
      syncId: 'editor-log',
      operation: 'restore',
      baseVersion: 3,
      confirm: true,
    });
    assert.equal(restored.status, 'accepted');
    assert.equal(storedLog('editor-log').version, 4);
    assert.equal(storedLog('editor-log').deleted_at, null);

    const viewerCreate = await mutate('viewer', {
      syncId: 'viewer-log',
      operation: 'create',
      baseVersion: 0,
      value: createValue('BA3VIEW'),
    });
    assert.equal(viewerCreate.status, 'rejected');
    assert.equal(viewerCreate.code, 'FORBIDDEN');
    assert.equal(storedLog('viewer-log'), undefined);
  });

  test('historical Logs without an author are immutable to members but remain governable by an administrator', async () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO logs (
        sync_id, session_id, version, time, controller, callsign,
        remarks, created_at, updated_at, created_by, updated_by
      ) VALUES ('historical-log', ?, 1, ?, 'BA0CTRL', 'BA4OLD',
                'legacy import', ?, ?, NULL, NULL)
    `).run(ids.session, '2026-07-13T10:00:00.000Z', now, now);

    for (const actor of ['owner', 'editor'] as const) {
      const rejected = await mutate(actor, {
        syncId: 'historical-log',
        operation: 'update',
        baseVersion: 1,
        patch: { remarks: `${actor} attempted update` },
      });
      assert.equal(rejected.status, 'rejected');
      assert.equal(rejected.code, 'LOG_AUTHOR_REQUIRED');
    }
    assert.equal(storedLog('historical-log').version, 1);
    assert.equal(storedLog('historical-log').created_by, null);

    const administrative = await request(
      `/api/v1/admin/sessions/${ids.session}/logs/historical-log`,
      {
        method: 'PATCH',
        userId: ids.admin,
        role: 'admin',
        headers: { 'idempotency-key': randomUUID() },
        body: {
          expectedVersion: 1,
          patch: { remarks: 'administrator correction' },
        },
      },
    );
    assert.equal(administrative.status, 200, administrative.text);
    assert.equal(administrative.body.result.status, 'accepted');
    assert.equal(storedLog('historical-log').version, 2);
    assert.equal(storedLog('historical-log').remarks, 'administrator correction');
    assert.equal(storedLog('historical-log').created_by, null);
    assert.equal(storedLog('historical-log').updated_by, ids.admin);
  });

  test('member Log pagination reports ownership and mutability without exposing cross-author controls', async () => {
    const ownerPage = await request(
      `/api/v1/sessions/${ids.session}/logs?includeDeleted=true&pageSize=20`,
      { userId: ids.owner },
    );
    assert.equal(ownerPage.status, 200, ownerPage.text);
    const ownerItems = new Map(
      ownerPage.body.items.map((item: JsonObject) => [item.syncId, item]),
    );
    assert.equal(ownerItems.get('owner-log')?.ownedByCurrentUser, true);
    assert.equal(ownerItems.get('owner-log')?.canMutate, true);
    assert.equal(ownerItems.get('editor-log')?.ownedByCurrentUser, false);
    assert.equal(ownerItems.get('editor-log')?.canMutate, false);
    assert.equal(ownerItems.get('historical-log')?.ownedByCurrentUser, false);
    assert.equal(ownerItems.get('historical-log')?.canMutate, false);

    const viewerPage = await request(
      `/api/v1/sessions/${ids.session}/logs?includeDeleted=true&pageSize=20`,
      { userId: ids.viewer },
    );
    assert.equal(viewerPage.status, 200, viewerPage.text);
    assert.ok(
      viewerPage.body.items.every((item: JsonObject) => item.canMutate === false),
      'Viewer pagination must never advertise a writable Log',
    );
  });
});
