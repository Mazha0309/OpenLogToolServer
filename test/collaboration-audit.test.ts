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
  requestId: string;
}

interface InviteSecret {
  inviteId: string;
  code: string;
  linkToken: string | null;
  body: JsonObject;
}

interface AuditRow {
  id: string;
  session_id: string;
  action: string;
  actor_user_id: string;
  target_user_id: string | null;
  request_id: string;
  mutation_id: string;
  before_json: string | null;
  after_json: string | null;
  details_json: string;
  occurred_at: string;
}

const deviceId = 'ea7c1a6c-a778-4fb1-833a-bd50150e9b55';
const passwordSentinel = 'NEVER_EXPOSE_COLLABORATION_AUDIT_PASSWORD_HASH';
const tokenSentinel = 'NEVER_EXPOSE_COLLABORATION_AUDIT_TOKEN_HASH';

const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'collaboration-audit-jwt-secret-80a47843-9cd0-45ce-976d-9f09bf62a5ea',
  jwtIssuer: 'openlogtool-collaboration-audit-test',
  bootstrapSecret: 'collaboration-audit-bootstrap-secret',
  inviteHmacKey: 'collaboration-audit-invite-hmac-key-168fd02c-bcc4-40ad-90fa',
  publicShareHmacKey: 'collaboration-audit-public-share-key-cfc778e7-ef5a-4434-a6b7',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

const actorDefinitions: Array<Pick<Actor, 'id' | 'role'>> = [
  { id: 'audit-owner-a', role: 'user' },
  { id: 'audit-owner-b', role: 'user' },
  { id: 'audit-editor', role: 'user' },
  { id: 'audit-member', role: 'user' },
  { id: 'audit-joiner', role: 'user' },
  { id: 'audit-outsider', role: 'user' },
  { id: 'audit-global-admin', role: 'admin' },
];

const auditItemKeys = [
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
];

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

function success(result: HttpResult, expected = 200): JsonObject {
  assert.equal(result.status, expected, result.text);
  return result.body;
}

function firstMutationResult(result: HttpResult): JsonObject {
  const body = success(result);
  assert.ok(Array.isArray(body.results));
  assert.equal(body.results.length, 1);
  assertObject(body.results[0], 'mutation result');
  return body.results[0];
}

function assertNullableAuditObject(
  value: unknown,
  label: string,
  expectedKeys: readonly string[] | null,
): void {
  if (expectedKeys === null) {
    assert.equal(value, null, `${label} must be null`);
    return;
  }
  assertObject(value, label);
  exactKeys(value, expectedKeys);
}

function assertActionPayloadWhitelist(item: JsonObject): void {
  const contracts: Record<
    string,
    { before: readonly string[] | null; after: readonly string[] | null; details: readonly string[] }
  > = {
    'membership.role.updated': {
      before: ['role', 'version'],
      after: ['role', 'version'],
      details: [],
    },
    'membership.removed': {
      before: ['role', 'version', 'removedAt'],
      after: ['role', 'version', 'removedAt'],
      details: [],
    },
    'ownership.transferred': {
      before: [
        'ownerUserId',
        'previousOwnerRole',
        'previousOwnerVersion',
        'newOwnerRole',
        'newOwnerVersion',
      ],
      after: [
        'ownerUserId',
        'previousOwnerRole',
        'previousOwnerVersion',
        'newOwnerRole',
        'newOwnerVersion',
      ],
      details: [],
    },
    'invite.created': {
      before: null,
      after: ['inviteId', 'role', 'maxUses', 'usedCount', 'expiresAt'],
      details: [],
    },
    'invite.redeemed': {
      before: [
        'inviteId',
        'usedCount',
        'membershipState',
        'membershipRole',
        'membershipVersion',
      ],
      after: [
        'inviteId',
        'usedCount',
        'membershipState',
        'membershipRole',
        'membershipVersion',
      ],
      details: ['roleGranted'],
    },
    'invite.revoked': {
      before: ['inviteId', 'role', 'maxUses', 'usedCount', 'expiresAt', 'revokedAt'],
      after: ['inviteId', 'role', 'maxUses', 'usedCount', 'expiresAt', 'revokedAt'],
      details: [],
    },
    'session.deleted': {
      before: ['status', 'version', 'eventSeq', 'deletedAt'],
      after: ['status', 'version', 'eventSeq', 'deletedAt'],
      details: [
        'revokedInviteCount',
        'revokedWsTicketCount',
        'revokedPublicShareCount',
        'revokedPublicWsTicketCount',
      ],
    },
  };
  const contract = contracts[String(item.action)];
  assert.ok(contract, `missing payload whitelist contract for ${String(item.action)}`);
  assertNullableAuditObject(item.before, `${String(item.action)} before`, contract.before);
  assertNullableAuditObject(item.after, `${String(item.action)} after`, contract.after);
  assertObject(item.details, `${String(item.action)} details`);
  exactKeys(item.details, contract.details);
}

describe('v1 collaboration security audit', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  const actors = new Map<string, Actor>();

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

  function actor(id: string): Actor {
    const value = actors.get(id);
    assert.ok(value, `missing actor ${id}`);
    return value;
  }

  async function request(
    path: string,
    options: {
      method?: string;
      actor?: Actor;
      body?: unknown;
      idempotencyKey?: string;
      requestId?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<HttpResult> {
    const requestId = options.requestId ?? randomUUID();
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': requestId,
        ...(options.actor
          ? { authorization: `Bearer ${options.actor.accessToken}` }
          : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.idempotencyKey
          ? { 'idempotency-key': options.idempotencyKey }
          : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    assertObject(parsed, 'HTTP response');
    return {
      status: response.status,
      headers: response.headers,
      body: parsed,
      text,
      requestId,
    };
  }

  function auditRows(sessionId: string, action?: string): AuditRow[] {
    return db.prepare(`
      SELECT
        id, session_id, action, actor_user_id, target_user_id,
        request_id, mutation_id, before_json, after_json, details_json, occurred_at
      FROM collaboration_audit_events
      WHERE session_id = ? ${action ? 'AND action = ?' : ''}
      ORDER BY occurred_at DESC, id DESC
    `).all(...(action ? [sessionId, action] : [sessionId])) as AuditRow[];
  }

  function auditCountForMutation(sessionId: string, mutationId: string): number {
    return Number(db.prepare(`
      SELECT COUNT(*) FROM collaboration_audit_events
      WHERE session_id = ? AND mutation_id = ?
    `).pluck().get(sessionId, mutationId));
  }

  async function createSession(owner: Actor, title: string): Promise<string> {
    const sessionId = randomUUID();
    success(
      await request(`/api/v1/sessions/${sessionId}`, {
        method: 'PUT',
        actor: owner,
        body: { title },
        idempotencyKey: randomUUID(),
        headers: { 'x-device-id': deviceId },
      }),
      201,
    );
    success(
      await request(`/api/v1/sessions/${sessionId}/activate`, {
        method: 'POST',
        actor: owner,
        body: { expectedLogCount: 0 },
        idempotencyKey: randomUUID(),
        headers: { 'x-device-id': deviceId },
      }),
    );
    return sessionId;
  }

  async function createInvite(
    owner: Actor,
    sessionId: string,
    mutationId: string,
    body: JsonObject = {
      role: 'editor',
      maxUses: 2,
      expiresInHours: 24,
      includeLinkToken: true,
    },
  ): Promise<{ result: HttpResult; secret: InviteSecret }> {
    const result = await request(`/api/v1/sessions/${sessionId}/invites`, {
      method: 'POST',
      actor: owner,
      body,
      idempotencyKey: mutationId,
    });
    const response = success(result, 201);
    assertObject(response.invite, 'invite');
    assert.equal(typeof response.invite.inviteId, 'string');
    assert.equal(typeof response.invite.code, 'string');
    return {
      result,
      secret: {
        inviteId: String(response.invite.inviteId),
        code: String(response.invite.code),
        linkToken: typeof response.invite.linkToken === 'string'
          ? response.invite.linkToken
          : null,
        body,
      },
    };
  }

  async function redeemInvite(
    joining: Actor,
    secret: InviteSecret,
    joinRequestId: string,
  ): Promise<HttpResult> {
    return request('/api/v1/collaboration-invites/redeem', {
      method: 'POST',
      actor: joining,
      idempotencyKey: joinRequestId,
      body: {
        code: secret.code,
        joinRequestId,
        deviceId,
      },
    });
  }

  async function mutateSession(
    acting: Actor,
    sessionId: string,
    operation: 'close' | 'delete',
    mutationId: string,
    baseVersion?: number,
  ): Promise<HttpResult> {
    const row = db.prepare('SELECT version FROM sessions WHERE id = ?').get(sessionId) as {
      version: number;
    };
    return request(`/api/v1/sessions/${sessionId}/mutations`, {
      method: 'POST',
      actor: acting,
      body: {
        protocolVersion: 1,
        deviceId,
        operations: [
          {
            mutationId,
            entityType: 'session',
            entityId: sessionId,
            operation,
            baseVersion: baseVersion ?? row.version,
          },
        ],
      },
    });
  }

  async function getAudit(
    sessionId: string,
    acting: Actor | undefined,
    query = '',
  ): Promise<HttpResult> {
    return request(`/api/v1/sessions/${sessionId}/audit-events${query}`, { actor: acting });
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-collaboration-audit-'));
    config.dbPath = join(directory, 'collaboration-audit.db');
    db = openDatabase(config.dbPath);

    const now = new Date().toISOString();
    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const definition of actorDefinitions) {
      insertUser.run(
        definition.id,
        definition.id,
        `${passwordSentinel}:${definition.id}`,
        definition.role,
        now,
        now,
      );
      actors.set(definition.id, {
        ...definition,
        accessToken: accessToken(definition.id, definition.role),
      });
    }
    db.prepare(`
      INSERT INTO refresh_tokens (
        id, user_id, token_hash, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, NULL)
    `).run(
      randomUUID(),
      actor('audit-outsider').id,
      tokenSentinel,
      now,
      new Date(Date.now() + 3_600_000).toISOString(),
    );

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

  test('records every collaboration security action once and remains readable after deletion', async () => {
    const originalOwner = actor('audit-owner-a');
    const joiningMember = actor('audit-joiner');
    const newOwner = actor('audit-member');
    const sessionId = await createSession(originalOwner, 'Complete collaboration audit trail');
    const secrets: string[] = [
      passwordSentinel,
      tokenSentinel,
      config.jwtSecret,
      config.inviteHmacKey,
    ];

    const createMemberMutation = `invite-member-${randomUUID()}`;
    const createdMember = await createInvite(
      originalOwner,
      sessionId,
      createMemberMutation,
    );
    secrets.push(createdMember.secret.code);
    if (createdMember.secret.linkToken) secrets.push(createdMember.secret.linkToken);
    const inviteHashes = db.prepare(`
      SELECT code_hash, link_token_hash FROM collaboration_invites WHERE id = ?
    `).get(createdMember.secret.inviteId) as {
      code_hash: string;
      link_token_hash: string | null;
    };
    secrets.push(inviteHashes.code_hash);
    if (inviteHashes.link_token_hash) secrets.push(inviteHashes.link_token_hash);

    const replayedCreate = await request(`/api/v1/sessions/${sessionId}/invites`, {
      method: 'POST',
      actor: originalOwner,
      body: createdMember.secret.body,
      idempotencyKey: createMemberMutation,
    });
    assert.deepEqual(success(replayedCreate, 201), createdMember.result.body);
    assert.equal(auditCountForMutation(sessionId, createMemberMutation), 1);

    const joinMutation = `join-member-${randomUUID()}`;
    const joined = await redeemInvite(joiningMember, createdMember.secret, joinMutation);
    success(joined, 201);
    assert.deepEqual(
      success(await redeemInvite(joiningMember, createdMember.secret, joinMutation), 201),
      joined.body,
    );
    assert.equal(auditCountForMutation(sessionId, joinMutation), 1);

    const roleMutation = `role-member-${randomUUID()}`;
    const roleBody = { role: 'viewer' };
    const roleChanged = await request(
      `/api/v1/sessions/${sessionId}/members/${joiningMember.id}`,
      {
        method: 'PATCH',
        actor: originalOwner,
        body: roleBody,
        idempotencyKey: roleMutation,
      },
    );
    success(roleChanged);
    assert.deepEqual(
      success(
        await request(`/api/v1/sessions/${sessionId}/members/${joiningMember.id}`, {
          method: 'PATCH',
          actor: originalOwner,
          body: roleBody,
          idempotencyKey: roleMutation,
        }),
      ),
      roleChanged.body,
    );
    assert.equal(auditCountForMutation(sessionId, roleMutation), 1);
    const roleAuditBeforeNoop = auditRows(sessionId, 'membership.role.updated').length;
    success(
      await request(`/api/v1/sessions/${sessionId}/members/${joiningMember.id}`, {
        method: 'PATCH',
        actor: originalOwner,
        body: roleBody,
        idempotencyKey: `role-noop-${randomUUID()}`,
      }),
    );
    assert.equal(
      auditRows(sessionId, 'membership.role.updated').length,
      roleAuditBeforeNoop,
      'a no-op role assignment must not produce an audit event',
    );

    const removeMutation = `remove-member-${randomUUID()}`;
    const removed = await request(
      `/api/v1/sessions/${sessionId}/members/${joiningMember.id}`,
      {
        method: 'DELETE',
        actor: originalOwner,
        idempotencyKey: removeMutation,
      },
    );
    success(removed);
    assert.deepEqual(
      success(
        await request(`/api/v1/sessions/${sessionId}/members/${joiningMember.id}`, {
          method: 'DELETE',
          actor: originalOwner,
          idempotencyKey: removeMutation,
        }),
      ),
      removed.body,
    );
    assert.equal(auditCountForMutation(sessionId, removeMutation), 1);

    const createOwnerMutation = `invite-owner-${randomUUID()}`;
    const createdOwner = await createInvite(
      originalOwner,
      sessionId,
      createOwnerMutation,
      { role: 'editor', maxUses: 1, includeLinkToken: true },
    );
    secrets.push(createdOwner.secret.code);
    if (createdOwner.secret.linkToken) secrets.push(createdOwner.secret.linkToken);
    const ownerJoinMutation = `join-owner-${randomUUID()}`;
    success(await redeemInvite(newOwner, createdOwner.secret, ownerJoinMutation), 201);

    const transferMutation = `transfer-owner-${randomUUID()}`;
    const transferBody = { newOwnerUserId: newOwner.id };
    success(
      await request(`/api/v1/sessions/${sessionId}/transfer-ownership`, {
        method: 'POST',
        actor: originalOwner,
        body: transferBody,
        idempotencyKey: transferMutation,
      }),
    );
    assert.equal(auditCountForMutation(sessionId, transferMutation), 1);
    assertError(
      await request(`/api/v1/sessions/${sessionId}/transfer-ownership`, {
        method: 'POST',
        actor: originalOwner,
        body: transferBody,
        idempotencyKey: transferMutation,
      }),
      403,
      'FORBIDDEN',
    );
    assert.equal(auditCountForMutation(sessionId, transferMutation), 1);
    const transferAuditBeforeNoop = auditRows(sessionId, 'ownership.transferred').length;
    success(
      await request(`/api/v1/sessions/${sessionId}/transfer-ownership`, {
        method: 'POST',
        actor: newOwner,
        body: { newOwnerUserId: newOwner.id },
        idempotencyKey: `transfer-noop-${randomUUID()}`,
      }),
    );
    assert.equal(
      auditRows(sessionId, 'ownership.transferred').length,
      transferAuditBeforeNoop,
      'transferring ownership to the current owner is a no-op',
    );

    const createRevokedMutation = `invite-revoke-${randomUUID()}`;
    const createdRevoked = await createInvite(
      newOwner,
      sessionId,
      createRevokedMutation,
      { role: 'viewer', maxUses: 1, includeLinkToken: true },
    );
    secrets.push(createdRevoked.secret.code);
    if (createdRevoked.secret.linkToken) secrets.push(createdRevoked.secret.linkToken);
    const revokeMutation = `revoke-invite-${randomUUID()}`;
    const revokePath = `/api/v1/sessions/${sessionId}/invites/${createdRevoked.secret.inviteId}`;
    const revoked = await request(revokePath, {
      method: 'DELETE',
      actor: newOwner,
      idempotencyKey: revokeMutation,
    });
    success(revoked);
    assert.deepEqual(
      success(
        await request(revokePath, {
          method: 'DELETE',
          actor: newOwner,
          idempotencyKey: revokeMutation,
        }),
      ),
      revoked.body,
    );
    assert.equal(auditCountForMutation(sessionId, revokeMutation), 1);
    const revokeAuditBeforeNoop = auditRows(sessionId, 'invite.revoked').length;
    success(
      await request(revokePath, {
        method: 'DELETE',
        actor: newOwner,
        idempotencyKey: `revoke-noop-${randomUUID()}`,
      }),
    );
    assert.equal(
      auditRows(sessionId, 'invite.revoked').length,
      revokeAuditBeforeNoop,
      'revoking an already revoked invite must not produce another audit event',
    );

    const closeMutation = randomUUID();
    assert.equal(firstMutationResult(await mutateSession(newOwner, sessionId, 'close', closeMutation)).status, 'accepted');
    const deleteMutation = randomUUID();
    const deleteBaseVersion = Number(
      db.prepare('SELECT version FROM sessions WHERE id = ?').pluck().get(sessionId),
    );
    const deleted = await mutateSession(
      newOwner,
      sessionId,
      'delete',
      deleteMutation,
      deleteBaseVersion,
    );
    assert.equal(firstMutationResult(deleted).status, 'accepted');
    assert.deepEqual(
      success(
        await mutateSession(
          newOwner,
          sessionId,
          'delete',
          deleteMutation,
          deleteBaseVersion,
        ),
      ),
      deleted.body,
    );
    assert.equal(auditCountForMutation(sessionId, deleteMutation), 1);

    const auditResponse = await getAudit(sessionId, newOwner, '?limit=100');
    const auditBody = success(auditResponse);
    assert.equal(auditResponse.headers.get('cache-control'), 'no-store');
    assert.ok(Array.isArray(auditBody.items));
    assertObject(auditBody.pageInfo, 'pageInfo');
    exactKeys(auditBody.pageInfo, ['limit', 'hasMore', 'nextCursor']);
    for (const rawItem of auditBody.items) {
      assertObject(rawItem, 'audit item');
      exactKeys(rawItem, auditItemKeys);
      assert.equal(typeof rawItem.auditEventId, 'string');
      assert.equal(typeof rawItem.actorUserId, 'string');
      assert.ok(rawItem.targetUserId === null || typeof rawItem.targetUserId === 'string');
      assert.equal(typeof rawItem.requestId, 'string');
      assert.equal(typeof rawItem.mutationId, 'string');
      assert.equal(typeof rawItem.occurredAt, 'string');
      assertActionPayloadWhitelist(rawItem);
    }
    const actions = new Set(
      (auditBody.items as JsonObject[]).map((item) => String(item.action)),
    );
    for (const action of [
      'membership.role.updated',
      'membership.removed',
      'ownership.transferred',
      'invite.created',
      'invite.redeemed',
      'invite.revoked',
      'session.deleted',
    ]) {
      assert.ok(actions.has(action), `missing collaboration audit action ${action}`);
    }
    const roleItem = (auditBody.items as JsonObject[]).find(
      (item) => item.action === 'membership.role.updated',
    );
    assertObject(roleItem, 'membership.role.updated audit item');
    assert.equal(roleItem.actorUserId, originalOwner.id);
    assert.equal(roleItem.targetUserId, joiningMember.id);
    assertObject(roleItem.before, 'membership.role.updated before');
    assertObject(roleItem.after, 'membership.role.updated after');
    assert.equal(roleItem.before.role, 'editor');
    assert.equal(roleItem.before.version, 1);
    assert.equal(roleItem.after.role, 'viewer');
    assert.equal(roleItem.after.version, 2);

    const removedItem = (auditBody.items as JsonObject[]).find(
      (item) => item.action === 'membership.removed',
    );
    assertObject(removedItem, 'membership.removed audit item');
    assert.equal(removedItem.targetUserId, joiningMember.id);
    assertObject(removedItem.before, 'membership.removed before');
    assertObject(removedItem.after, 'membership.removed after');
    assert.equal(removedItem.before.removedAt, null);
    assert.equal(typeof removedItem.after.removedAt, 'string');

    const transferItem = (auditBody.items as JsonObject[]).find(
      (item) => item.action === 'ownership.transferred',
    );
    assertObject(transferItem, 'ownership.transferred audit item');
    assert.equal(transferItem.targetUserId, newOwner.id);
    assertObject(transferItem.before, 'ownership.transferred before');
    assertObject(transferItem.after, 'ownership.transferred after');
    assert.equal(transferItem.before.ownerUserId, originalOwner.id);
    assert.equal(transferItem.after.ownerUserId, newOwner.id);

    const inviteCreatedItems = (auditBody.items as JsonObject[]).filter(
      (item) => item.action === 'invite.created',
    );
    assert.ok(inviteCreatedItems.length >= 3);
    for (const item of inviteCreatedItems) assert.equal(item.targetUserId, null);
    const inviteRedeemedItems = (auditBody.items as JsonObject[]).filter(
      (item) => item.action === 'invite.redeemed',
    );
    assert.ok(inviteRedeemedItems.length >= 2);
    for (const item of inviteRedeemedItems) assert.equal(item.targetUserId, item.actorUserId);
    const inviteRevokedItem = (auditBody.items as JsonObject[]).find(
      (item) => item.action === 'invite.revoked',
    );
    assertObject(inviteRevokedItem, 'invite.revoked audit item');
    assert.equal(inviteRevokedItem.targetUserId, null);
    assertObject(inviteRevokedItem.before, 'invite.revoked before');
    assertObject(inviteRevokedItem.after, 'invite.revoked after');
    assert.equal(inviteRevokedItem.before.revokedAt, null);
    assert.equal(typeof inviteRevokedItem.after.revokedAt, 'string');
    const deleteItem = (auditBody.items as JsonObject[]).find(
      (item) => item.action === 'session.deleted',
    );
    assertObject(deleteItem, 'session.deleted audit item');
    assert.equal(deleteItem.targetUserId, null);
    assertObject(deleteItem.before, 'session.deleted before');
    assertObject(deleteItem.after, 'session.deleted after');
    assert.equal(deleteItem.before.deletedAt, null);
    assert.equal(typeof deleteItem.after.deletedAt, 'string');

    assertError(await getAudit(sessionId, originalOwner), 403, 'FORBIDDEN');
    assertError(
      await getAudit(sessionId, joiningMember),
      403,
      'MEMBERSHIP_REVOKED',
    );

    const persistedAuditText = auditRows(sessionId)
      .map((row) => [row.before_json, row.after_json, row.details_json].join('\n'))
      .join('\n');
    for (const secret of secrets) {
      assert.ok(secret.length > 0);
      assert.equal(auditResponse.text.includes(secret), false, `audit API leaked ${secret}`);
      assert.equal(persistedAuditText.includes(secret), false, `stored audit JSON leaked ${secret}`);
    }
    const firstAudit = auditRows(sessionId)[0];
    assert.throws(
      () => db.prepare('UPDATE collaboration_audit_events SET details_json = ? WHERE id = ?')
        .run('{}', firstAudit.id),
      /collaboration audit events are append-only/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM collaboration_audit_events WHERE id = ?').run(firstAudit.id),
      /collaboration audit events are append-only/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO collaboration_audit_events (
          id, session_id, action, actor_user_id, target_user_id,
          request_id, mutation_id, before_json, after_json, details_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        firstAudit.id,
        firstAudit.session_id,
        firstAudit.action,
        firstAudit.actor_user_id,
        firstAudit.target_user_id,
        firstAudit.request_id,
        firstAudit.mutation_id,
        firstAudit.before_json,
        firstAudit.after_json,
        firstAudit.details_json,
        firstAudit.occurred_at,
      ),
      /collaboration audit events are append-only/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO collaboration_audit_events (
          id, session_id, action, actor_user_id, target_user_id,
          request_id, mutation_id, before_json, after_json, details_json, occurred_at
        ) VALUES (NULL, ?, 'invite.created', ?, NULL, ?, ?, NULL, ?, '{}', ?)
      `).run(
        sessionId,
        newOwner.id,
        randomUUID(),
        randomUUID(),
        JSON.stringify({
          inviteId: randomUUID(),
          role: 'viewer',
          maxUses: 1,
          usedCount: 0,
          expiresAt: '2100-01-01T00:00:00.000Z',
        }),
        '2099-01-01T00:00:00.000Z',
      ),
      /NOT NULL constraint failed: collaboration_audit_events.id/,
    );
  });

  test('enforces owner-only IDOR protection and a session-bound HMAC cursor', async () => {
    const owner = actor('audit-owner-a');
    const otherOwner = actor('audit-owner-b');
    const editor = actor('audit-editor');
    const sessionId = await createSession(owner, 'Cursor and IDOR audit Session');
    const otherSessionId = await createSession(owner, 'Different cursor scope');

    const memberInvite = await createInvite(
      owner,
      sessionId,
      `cursor-member-invite-${randomUUID()}`,
      { role: 'editor', maxUses: 1 },
    );
    success(
      await redeemInvite(editor, memberInvite.secret, `cursor-member-join-${randomUUID()}`),
      201,
    );
    success(
      await request(`/api/v1/sessions/${sessionId}/members/${editor.id}`, {
        method: 'PATCH',
        actor: owner,
        body: { role: 'viewer' },
        idempotencyKey: `cursor-member-role-${randomUUID()}`,
      }),
    );
    for (let index = 0; index < 3; index += 1) {
      await createInvite(
        owner,
        sessionId,
        `cursor-invite-${index}-${randomUUID()}`,
        { role: 'viewer', maxUses: 1 },
      );
    }
    await createInvite(
      owner,
      otherSessionId,
      `other-session-invite-${randomUUID()}`,
      { role: 'viewer', maxUses: 1 },
    );

    assertError(await getAudit(sessionId, undefined), 401, 'AUTH_REQUIRED');
    assertError(await getAudit(sessionId, editor), 403, 'FORBIDDEN');
    assertError(await getAudit(sessionId, actor('audit-outsider')), 404, 'NOT_FOUND');
    assertError(
      await getAudit(sessionId, editor, '?cursor=not-a-valid-signed-cursor'),
      403,
      'FORBIDDEN',
    );
    assertError(
      await getAudit(
        sessionId,
        actor('audit-outsider'),
        '?cursor=not-a-valid-signed-cursor',
      ),
      404,
      'NOT_FOUND',
    );
    assertError(await getAudit(sessionId, otherOwner), 404, 'NOT_FOUND');
    assertError(await getAudit(sessionId, actor('audit-global-admin')), 404, 'NOT_FOUND');
    assertError(await getAudit(randomUUID(), owner), 404, 'NOT_FOUND');

    const firstPage = await getAudit(
      sessionId,
      owner,
      '?action=invite.created&limit=1',
    );
    const firstBody = success(firstPage);
    assert.equal(firstPage.headers.get('cache-control'), 'no-store');
    assert.ok(Array.isArray(firstBody.items));
    assert.equal(firstBody.items.length, 1);
    assertObject(firstBody.pageInfo, 'first page info');
    assert.equal(firstBody.pageInfo.hasMore, true);
    assert.equal(typeof firstBody.pageInfo.nextCursor, 'string');
    const cursor = String(firstBody.pageInfo.nextCursor);

    const secondPage = success(
      await getAudit(
        sessionId,
        owner,
        `?action=invite.created&limit=1&cursor=${encodeURIComponent(cursor)}`,
      ),
    );
    assert.ok(Array.isArray(secondPage.items));
    assert.equal(secondPage.items.length, 1);
    assertObject(firstBody.items[0], 'first cursor item');
    assertObject(secondPage.items[0], 'second cursor item');
    assert.notEqual(secondPage.items[0].auditEventId, firstBody.items[0].auditEventId);

    const tamperIndex = Math.floor(cursor.length / 2);
    const tamperedCursor = `${cursor.slice(0, tamperIndex)}${cursor[tamperIndex] === 'A' ? 'B' : 'A'}${cursor.slice(tamperIndex + 1)}`;
    assertError(
      await getAudit(
        sessionId,
        owner,
        `?action=invite.created&limit=1&cursor=${encodeURIComponent(tamperedCursor)}`,
      ),
      422,
      'VALIDATION_FAILED',
    );
    assertError(
      await getAudit(
        sessionId,
        owner,
        `?action=invite.revoked&limit=1&cursor=${encodeURIComponent(cursor)}`,
      ),
      422,
      'VALIDATION_FAILED',
    );
    assertError(
      await getAudit(
        otherSessionId,
        owner,
        `?action=invite.created&limit=1&cursor=${encodeURIComponent(cursor)}`,
      ),
      422,
      'VALIDATION_FAILED',
    );

    const targetFiltered = success(
      await getAudit(
        sessionId,
        owner,
        `?action=membership.role.updated&actorUserId=${owner.id}&targetUserId=${editor.id}`,
      ),
    );
    assert.ok(Array.isArray(targetFiltered.items));
    assert.equal(targetFiltered.items.length, 1);
    assertObject(targetFiltered.items[0], 'target-filtered item');
    assert.equal(targetFiltered.items[0].actorUserId, owner.id);
    assert.equal(targetFiltered.items[0].targetUserId, editor.id);

    const occurredAt = String(targetFiltered.items[0].occurredAt);
    const from = encodeURIComponent(occurredAt);
    const to = encodeURIComponent(new Date(Date.parse(occurredAt) + 1).toISOString());
    const windowed = success(
      await getAudit(
        sessionId,
        owner,
        `?action=membership.role.updated&from=${from}&to=${to}`,
      ),
    );
    assert.ok(Array.isArray(windowed.items));
    assert.ok(
      (windowed.items as JsonObject[]).some(
        (item) => item.auditEventId === targetFiltered.items[0].auditEventId,
      ),
    );

    for (const query of [
      '?unknown=true',
      '?action=',
      '?action=not.supported',
      '?actorUserId=',
      '?targetUserId=',
      '?limit=0',
      '?limit=101',
      '?limit=1&limit=2',
      '?from=',
      '?from=invalid',
      '?to=',
      '?from=2026-01-02T00%3A00%3A00.000Z&to=2026-01-01T00%3A00%3A00.000Z',
      '?cursor=',
      '?cursor=not-a-valid-signed-cursor',
    ]) {
      assertError(await getAudit(sessionId, owner, query), 422, 'VALIDATION_FAILED');
    }

    const sameTime = '2099-01-01T00:00:00.000Z';
    const insertAudit = db.prepare(`
      INSERT INTO collaboration_audit_events (
        id, session_id, action, actor_user_id, target_user_id,
        request_id, mutation_id, before_json, after_json, details_json, occurred_at
      ) VALUES (?, ?, 'invite.created', ?, NULL, ?, ?, NULL, ?, '{}', ?)
    `);
    for (const id of ['tie-a', 'tie-b', 'tie-c']) {
      insertAudit.run(
        id,
        sessionId,
        owner.id,
        `request-${id}`,
        `mutation-${id}`,
        JSON.stringify({
          inviteId: id,
          role: 'viewer',
          maxUses: 1,
          usedCount: 0,
          expiresAt: '2100-01-01T00:00:00.000Z',
        }),
        sameTime,
      );
    }
    const tieQuery = `action=invite.created&from=${encodeURIComponent(sameTime)}&to=${encodeURIComponent('2100-01-01T00:00:00.000Z')}&limit=1`;
    const seenTieIds: string[] = [];
    let nextCursor: string | null = null;
    do {
      const page = success(
        await getAudit(
          sessionId,
          owner,
          `?${tieQuery}${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''}`,
        ),
      );
      assert.ok(Array.isArray(page.items));
      for (const rawItem of page.items) {
        assertObject(rawItem, 'tie item');
        seenTieIds.push(String(rawItem.auditEventId));
      }
      assertObject(page.pageInfo, 'tie page info');
      nextCursor = page.pageInfo.nextCursor === null
        ? null
        : String(page.pageInfo.nextCursor);
    } while (nextCursor);
    assert.deepEqual(seenTieIds, ['tie-c', 'tie-b', 'tie-a']);

    const transferMutationId = `cursor-owner-transfer-${randomUUID()}`;
    success(
      await request(`/api/v1/sessions/${sessionId}/transfer-ownership`, {
        method: 'POST',
        actor: owner,
        body: { newOwnerUserId: editor.id },
        idempotencyKey: transferMutationId,
      }),
    );
    assertError(
      await getAudit(
        sessionId,
        owner,
        `?action=invite.created&limit=1&cursor=${encodeURIComponent(cursor)}`,
      ),
      403,
      'FORBIDDEN',
    );
    assertError(
      await getAudit(
        sessionId,
        editor,
        `?action=invite.created&limit=1&cursor=${encodeURIComponent(cursor)}`,
      ),
      422,
      'VALIDATION_FAILED',
    );

    const rejectedMutationId = randomUUID();
    const rejectedBaseVersion = Number(
      db.prepare('SELECT version FROM sessions WHERE id = ?').pluck().get(sessionId),
    );
    const rejected = await mutateSession(
      owner,
      sessionId,
      'close',
      rejectedMutationId,
      rejectedBaseVersion,
    );
    const rejectedResult = firstMutationResult(rejected);
    assert.equal(rejectedResult.status, 'rejected');
    assert.equal(rejectedResult.code, 'FORBIDDEN');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?')
        .pluck().get(rejectedMutationId),
      1,
      'the first authorization rejection must be durable',
    );
    success(
      await request(`/api/v1/sessions/${sessionId}/transfer-ownership`, {
        method: 'POST',
        actor: editor,
        body: { newOwnerUserId: owner.id },
        idempotencyKey: `cursor-owner-transfer-back-${randomUUID()}`,
      }),
    );
    const replayedRejection = await mutateSession(
      owner,
      sessionId,
      'close',
      rejectedMutationId,
      rejectedBaseVersion,
    );
    assert.deepEqual(success(replayedRejection), rejected.body);
    assert.equal(
      db.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get(sessionId),
      'active',
      'a durable rejected mutation must not execute after the actor becomes Owner',
    );
  });

  test('rejects a stored audit payload that contains a non-whitelisted secret field', async () => {
    const owner = actor('audit-owner-b');
    const sessionId = await createSession(owner, 'Stored audit whitelist validation');
    const occurredAt = '2098-01-01T00:00:00.000Z';
    const secret = 'STORED_AUDIT_LINK_TOKEN_MUST_NEVER_ESCAPE';
    db.prepare(`
      INSERT INTO collaboration_audit_events (
        id, session_id, action, actor_user_id, target_user_id,
        request_id, mutation_id, before_json, after_json, details_json, occurred_at
      ) VALUES (?, ?, 'invite.created', ?, NULL, ?, ?, NULL, ?, '{}', ?)
    `).run(
      randomUUID(),
      sessionId,
      owner.id,
      randomUUID(),
      randomUUID(),
      JSON.stringify({
        inviteId: randomUUID(),
        role: 'viewer',
        maxUses: 1,
        usedCount: 0,
        expiresAt: '2099-01-01T00:00:00.000Z',
        linkToken: secret,
      }),
      occurredAt,
    );

    const response = await getAudit(
      sessionId,
      owner,
      `?action=invite.created&from=${encodeURIComponent(occurredAt)}&to=${encodeURIComponent('2098-01-02T00:00:00.000Z')}`,
    );
    assertError(response, 500, 'COLLABORATION_AUDIT_INVALID');
    assert.equal(response.text.includes(secret), false);
  });

  test('rolls an ownership transfer back completely when its audit insert fails', async () => {
    const owner = actor('audit-owner-a');
    const candidate = actor('audit-outsider');
    const sessionId = await createSession(owner, 'Ownership audit rollback Session');
    const created = await createInvite(
      owner,
      sessionId,
      `ownership-rollback-invite-${randomUUID()}`,
      { role: 'viewer', maxUses: 1 },
    );
    success(
      await redeemInvite(
        candidate,
        created.secret,
        `ownership-rollback-join-${randomUUID()}`,
      ),
      201,
    );
    const mutationId = randomUUID();
    const beforeSessionOwner = db.prepare(
      'SELECT owner_user_id FROM sessions WHERE id = ?',
    ).pluck().get(sessionId);
    const beforeMemberships = db.prepare(`
      SELECT user_id, role, version, updated_at
      FROM session_members
      WHERE session_id = ? AND user_id IN (?, ?)
      ORDER BY user_id
    `).all(sessionId, owner.id, candidate.id);
    const triggerName = 'test_fail_ownership_transfer_audit';
    db.exec(`
      CREATE TEMP TRIGGER ${triggerName}
      BEFORE INSERT ON collaboration_audit_events
      WHEN NEW.action = 'ownership.transferred' AND NEW.mutation_id = '${mutationId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced ownership audit failure');
      END;
    `);

    const originalConsoleError = console.error;
    console.error = () => undefined;
    let failed: HttpResult;
    try {
      failed = await request(`/api/v1/sessions/${sessionId}/transfer-ownership`, {
        method: 'POST',
        actor: owner,
        body: { newOwnerUserId: candidate.id },
        idempotencyKey: mutationId,
      });
    } finally {
      console.error = originalConsoleError;
      db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }
    assertError(failed!, 500, 'INTERNAL_ERROR');
    assert.equal(
      db.prepare('SELECT owner_user_id FROM sessions WHERE id = ?').pluck().get(sessionId),
      beforeSessionOwner,
    );
    assert.deepEqual(
      db.prepare(`
        SELECT user_id, role, version, updated_at
        FROM session_members
        WHERE session_id = ? AND user_id IN (?, ?)
        ORDER BY user_id
      `).all(sessionId, owner.id, candidate.id),
      beforeMemberships,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?')
        .pluck().get(mutationId),
      0,
    );
    assert.equal(auditCountForMutation(sessionId, mutationId), 0);

    success(
      await request(`/api/v1/sessions/${sessionId}/transfer-ownership`, {
        method: 'POST',
        actor: owner,
        body: { newOwnerUserId: candidate.id },
        idempotencyKey: mutationId,
      }),
    );
    assert.equal(
      db.prepare('SELECT owner_user_id FROM sessions WHERE id = ?').pluck().get(sessionId),
      candidate.id,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?')
        .pluck().get(mutationId),
      1,
    );
    assert.equal(auditCountForMutation(sessionId, mutationId), 1);
  });

  test('rolls invite redemption back completely when its audit insert fails', async () => {
    const owner = actor('audit-owner-b');
    const joining = actor('audit-joiner');
    const sessionId = await createSession(owner, 'Audit rollback Session');
    const created = await createInvite(
      owner,
      sessionId,
      `rollback-invite-${randomUUID()}`,
      { role: 'viewer', maxUses: 1 },
    );
    const joinRequestId = randomUUID();
    const triggerName = 'test_fail_collaboration_audit_insert';
    db.exec(`
      CREATE TEMP TRIGGER ${triggerName}
      BEFORE INSERT ON collaboration_audit_events
      WHEN NEW.action = 'invite.redeemed' AND NEW.mutation_id = '${joinRequestId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced collaboration audit failure');
      END;
    `);

    const originalConsoleError = console.error;
    console.error = () => undefined;
    let failed: HttpResult;
    try {
      failed = await redeemInvite(joining, created.secret, joinRequestId);
    } finally {
      console.error = originalConsoleError;
      db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }
    assertError(failed!, 500, 'INTERNAL_ERROR');
    assert.equal(
      db.prepare('SELECT used_count FROM collaboration_invites WHERE id = ?')
        .pluck().get(created.secret.inviteId),
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM invite_redemptions WHERE join_request_id = ?')
        .pluck().get(joinRequestId),
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM session_members WHERE session_id = ? AND user_id = ?')
        .pluck().get(sessionId, joining.id),
      0,
    );
    assert.equal(auditCountForMutation(sessionId, joinRequestId), 0);

    success(await redeemInvite(joining, created.secret, joinRequestId), 201);
    assert.equal(
      db.prepare('SELECT used_count FROM collaboration_invites WHERE id = ?')
        .pluck().get(created.secret.inviteId),
      1,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM invite_redemptions WHERE join_request_id = ?')
        .pluck().get(joinRequestId),
      1,
    );
    assert.equal(auditCountForMutation(sessionId, joinRequestId), 1);
  });
});
