import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createCollaborationInvitesV1Router } from '../src/api/collaboration-invites-v1';
import { createSessionMembershipV1Router } from '../src/api/session-members-v1';
import { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';
import { errorMiddleware, notFoundMiddleware } from '../src/middleware/error-handler';
import { requestIdMiddleware } from '../src/middleware/request-id';

const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'membership-invite-test-jwt-secret-32-bytes-minimum',
  jwtIssuer: 'membership-invite-test',
  bootstrapSecret: 'membership-invite-bootstrap-secret',
  inviteHmacKey: 'membership-invite-hmac-key-that-is-at-least-32-bytes',
  publicShareHmacKey: 'membership-public-share-hmac-key-at-least-32-bytes',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

const ids = {
  owner: 'user-owner',
  editor: 'user-editor',
  viewer: 'user-viewer',
  outsider: 'user-outsider',
  secondOutsider: 'user-second-outsider',
  session: 'session-membership-test',
};

interface Result {
  status: number;
  body: any;
}

async function createHarness() {
  const db = openDatabase(':memory:');
  const now = new Date().toISOString();
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
    VALUES (?, ?, 'unused', 'user', ?, ?)
  `);
  for (const [key, userId] of Object.entries(ids)) {
    if (key === 'session') continue;
    insertUser.run(userId, key, now, now);
  }
  db.prepare(`
    INSERT INTO sessions (
      id, title, status, owner_user_id, version, event_seq,
      min_retained_seq, created_at, updated_at
    ) VALUES (?, 'Membership test', 'active', ?, 1, 7, 0, ?, ?)
  `).run(ids.session, ids.owner, now, now);
  const insertMember = db.prepare(`
    INSERT INTO session_members (
      id, session_id, user_id, role, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  insertMember.run(randomUUID(), ids.session, ids.owner, 'owner', now, now);
  insertMember.run(randomUUID(), ids.session, ids.editor, 'editor', now, now);
  insertMember.run(randomUUID(), ids.session, ids.viewer, 'viewer', now, now);

  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(
    '/api/v1/sessions',
    createSessionMembershipV1Router({ db, config }),
  );
  app.use(
    '/api/v1/collaboration-invites',
    createCollaborationInvitesV1Router({ db, config }),
  );
  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  function accessToken(userId: string): string {
    return jwt.sign(
      { type: 'access', role: 'user' },
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
    method: string,
    path: string,
    userId: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<Result> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken(userId)}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  async function close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
  }

  return { db, server: server as Server, request, close };
}

function errorCode(result: Result): string | undefined {
  return result.body?.error?.code;
}

test('owner invite creation is durable, secret-safe and idempotent', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const createBody = {
    role: 'editor',
    expiresInHours: 24,
    maxUses: 1,
    includeLinkToken: true,
  };
  const created = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    createBody,
    'create-invite-1',
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.invite.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.ok(created.body.invite.linkToken.length >= 22);
  assert.equal(created.body.invite.role, 'editor');
  assert.equal(created.body.invite.maxUses, 1);
  assert.equal('codeHash' in created.body.invite, false);
  assert.equal('linkTokenHash' in created.body.invite, false);

  const inviteRow = harness.db.prepare(`
    SELECT code_hash, link_token_hash FROM collaboration_invites WHERE id = ?
  `).get(created.body.invite.inviteId) as { code_hash: string; link_token_hash: string };
  assert.notEqual(inviteRow.code_hash, created.body.invite.code.replace('-', ''));
  assert.notEqual(inviteRow.link_token_hash, created.body.invite.linkToken);
  const stored = harness.db.prepare(`
    SELECT response_json FROM processed_mutations WHERE mutation_id = 'create-invite-1'
  `).get() as { response_json: string };
  assert.equal(stored.response_json.includes(created.body.invite.code), false);
  assert.equal(stored.response_json.includes(created.body.invite.linkToken), false);

  const replay = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    createBody,
    'create-invite-1',
  );
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, created.body);
  assert.equal(
    Number(harness.db.prepare('SELECT COUNT(*) AS count FROM collaboration_invites').get()?.count),
    1,
  );

  const reused = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    { ...createBody, role: 'viewer' },
    'create-invite-1',
  );
  assert.equal(reused.status, 409);
  assert.equal(errorCode(reused), 'MUTATION_ID_REUSED');

  const listed = await harness.request(
    'GET',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.body.invites.length, 1);
  assert.equal('code' in listed.body.invites[0], false);
  assert.equal('linkToken' in listed.body.invites[0], false);

  const forbidden = await harness.request(
    'GET',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.viewer,
  );
  assert.equal(forbidden.status, 403);
  assert.equal(errorCode(forbidden), 'FORBIDDEN');

  const fingerprint = harness.db.prepare(`
    SELECT invite_hmac_fingerprint FROM server_settings WHERE id = 1
  `).get() as { invite_hmac_fingerprint: string };
  assert.match(fingerprint.invite_hmac_fingerprint, /^[0-9a-f]{64}$/);
  harness.db.prepare(`
    UPDATE server_settings SET invite_hmac_fingerprint = 'changed-key'
    WHERE id = 1
  `).run();
  const changedKey = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    { role: 'viewer' },
    'changed-hmac-key',
  );
  assert.equal(changedKey.status, 503);
  assert.equal(errorCode(changedKey), 'INVITE_HMAC_KEY_CHANGED');
});

test('redemption is atomic, capped and idempotent without role downgrade', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const created = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    { role: 'editor', maxUses: 1 },
    'redeemable-invite',
  );
  assert.equal(created.status, 201);
  const redeemed = await harness.request(
    'POST',
    '/api/v1/collaboration-invites/redeem',
    ids.outsider,
    {
      code: created.body.invite.code,
      joinRequestId: 'join-request-one',
      deviceId: 'device-one',
    },
    'join-request-one',
  );
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.body));
  assert.equal(redeemed.body.membership.role, 'editor');
  assert.equal(redeemed.body.session.sessionId, ids.session);
  assert.equal(redeemed.body.highWatermarkSeq, 7);

  const replay = await harness.request(
    'POST',
    '/api/v1/collaboration-invites/redeem',
    ids.outsider,
    { code: created.body.invite.code, joinRequestId: 'join-request-one', deviceId: 'device-one' },
    'join-request-one',
  );
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, redeemed.body);
  harness.db.prepare(`
    UPDATE session_members
    SET role = 'viewer', version = version + 1, updated_at = ?
    WHERE session_id = ? AND user_id = ?
  `).run(new Date().toISOString(), ids.session, ids.outsider);
  harness.db.prepare(`
    UPDATE sessions SET event_seq = 99, updated_at = ? WHERE id = ?
  `).run(new Date().toISOString(), ids.session);
  const stableReplay = await harness.request(
    'POST',
    '/api/v1/collaboration-invites/redeem',
    ids.outsider,
    { code: created.body.invite.code, joinRequestId: 'join-request-one', deviceId: 'device-one' },
    'join-request-one',
  );
  assert.equal(stableReplay.status, 201);
  assert.deepEqual(stableReplay.body, redeemed.body, 'replay must return the first canonical response');
  const changedDevice = await harness.request(
    'POST',
    '/api/v1/collaboration-invites/redeem',
    ids.outsider,
    { code: created.body.invite.code, joinRequestId: 'join-request-one', deviceId: 'device-two' },
    'join-request-one',
  );
  assert.equal(changedDevice.status, 409);
  assert.equal(errorCode(changedDevice), 'JOIN_REQUEST_ID_REUSED');
  const mismatchedHeader = await harness.request(
    'POST',
    '/api/v1/collaboration-invites/redeem',
    ids.outsider,
    { code: created.body.invite.code, joinRequestId: 'join-request-one' },
    'different-request-id',
  );
  assert.equal(mismatchedHeader.status, 409);
  assert.equal(errorCode(mismatchedHeader), 'IDEMPOTENCY_KEY_MISMATCH');
  const inviteState = harness.db.prepare(`
    SELECT used_count FROM collaboration_invites WHERE id = ?
  `).get(created.body.invite.inviteId) as { used_count: number };
  assert.equal(inviteState.used_count, 1);
  assert.equal(
    Number(harness.db.prepare('SELECT COUNT(*) AS count FROM invite_redemptions').get()?.count),
    1,
  );

  const exhausted = await harness.request(
    'POST',
    '/api/v1/collaboration-invites/redeem',
    ids.secondOutsider,
    { code: created.body.invite.code, joinRequestId: 'join-request-two' },
  );
  assert.equal(exhausted.status, 404);
  assert.equal(errorCode(exhausted), 'INVITE_INVALID');

  const viewerInvite = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    { role: 'viewer', maxUses: 2 },
    'viewer-invite',
  );
  const noDowngrade = await harness.request(
    'POST',
    '/api/v1/collaboration-invites/redeem',
    ids.editor,
    { code: viewerInvite.body.invite.code, joinRequestId: 'editor-viewer-redeem' },
  );
  assert.equal(noDowngrade.status, 201);
  assert.equal(noDowngrade.body.membership.role, 'editor');
});

test('member administration enforces revocation and transactional ownership transfer', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const patched = await harness.request(
    'PATCH',
    `/api/v1/sessions/${ids.session}/members/${ids.viewer}`,
    ids.owner,
    { role: 'editor' },
    'promote-viewer',
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.membership.role, 'editor');
  assert.equal(patched.body.membership.version, 2);

  const ownerRemoval = await harness.request(
    'DELETE',
    `/api/v1/sessions/${ids.session}/members/${ids.owner}`,
    ids.owner,
    undefined,
    'remove-owner',
  );
  assert.equal(ownerRemoval.status, 409);
  assert.equal(errorCode(ownerRemoval), 'OWNER_TRANSFER_REQUIRED');

  const removed = await harness.request(
    'DELETE',
    `/api/v1/sessions/${ids.session}/members/${ids.viewer}`,
    ids.owner,
    undefined,
    'remove-viewer',
  );
  assert.equal(removed.status, 200);
  const revokedSelf = await harness.request(
    'GET',
    `/api/v1/sessions/${ids.session}/membership`,
    ids.viewer,
  );
  assert.equal(revokedSelf.status, 403);
  assert.equal(errorCode(revokedSelf), 'MEMBERSHIP_REVOKED');
  const noMembership = await harness.request(
    'GET',
    `/api/v1/sessions/${ids.session}/membership`,
    ids.outsider,
  );
  assert.equal(noMembership.status, 404);
  assert.equal(errorCode(noMembership), 'NOT_FOUND');

  const transfer = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/transfer-ownership`,
    ids.owner,
    { newOwnerUserId: ids.editor },
    'transfer-owner',
  );
  assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
  assert.equal(transfer.body.previousOwner.role, 'editor');
  assert.equal(transfer.body.owner.role, 'owner');
  const replay = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/transfer-ownership`,
    ids.owner,
    { newOwnerUserId: ids.editor },
    'transfer-owner',
  );
  assert.equal(replay.status, 403);
  assert.equal(errorCode(replay), 'FORBIDDEN');
  assert.equal(
    Number(harness.db.prepare(`
      SELECT COUNT(*) FROM collaboration_audit_events
      WHERE session_id = ? AND action = 'ownership.transferred'
        AND mutation_id = 'transfer-owner'
    `).pluck().get(ids.session)),
    1,
  );
  const ownership = harness.db.prepare(`
    SELECT owner_user_id FROM sessions WHERE id = ?
  `).get(ids.session) as { owner_user_id: string };
  assert.equal(ownership.owner_user_id, ids.editor);
  assert.equal(
    Number(
      harness.db.prepare(`
        SELECT COUNT(*) AS count FROM session_members
        WHERE session_id = ? AND role = 'owner' AND removed_at IS NULL
      `).get(ids.session)?.count,
    ),
    1,
  );

  const formerOwnerDenied = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    { role: 'viewer' },
    'former-owner-invite',
  );
  assert.equal(formerOwnerDenied.status, 403);
  assert.equal(errorCode(formerOwnerDenied), 'FORBIDDEN');
});

test('revoked historical roles cannot survive a lower-role rejoin', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const removed = await harness.request(
    'DELETE',
    `/api/v1/sessions/${ids.session}/members/${ids.editor}`,
    ids.owner,
    undefined,
    'remove-editor-before-rejoin',
  );
  assert.equal(removed.status, 200);
  const invite = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    { role: 'viewer' },
    'viewer-rejoin-invite',
  );
  assert.equal(invite.status, 201);
  const rejoined = await harness.request(
    'POST',
    '/api/v1/collaboration-invites/redeem',
    ids.editor,
    { code: invite.body.invite.code, joinRequestId: 'viewer-rejoin-request' },
    'viewer-rejoin-request',
  );
  assert.equal(rejoined.status, 201, JSON.stringify(rejoined.body));
  assert.equal(rejoined.body.membership.role, 'viewer');
});

test('secret-bearing invite replay rechecks current owner permission', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const body = { role: 'viewer', includeLinkToken: true };
  const created = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    body,
    'owner-secret-before-transfer',
  );
  assert.equal(created.status, 201);
  const transferred = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/transfer-ownership`,
    ids.owner,
    { newOwnerUserId: ids.editor },
    'transfer-after-secret',
  );
  assert.equal(transferred.status, 200);
  const replay = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    body,
    'owner-secret-before-transfer',
  );
  assert.equal(replay.status, 403);
  assert.equal(errorCode(replay), 'FORBIDDEN');
});

test('revoked and expired invites share the non-enumerating error', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const revokedInvite = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    { role: 'viewer' },
    'invite-to-revoke',
  );
  const revoked = await harness.request(
    'DELETE',
    `/api/v1/sessions/${ids.session}/invites/${revokedInvite.body.invite.inviteId}`,
    ids.owner,
    undefined,
    'revoke-invite',
  );
  assert.equal(revoked.status, 200);
  const revokedRedeem = await harness.request(
    'POST',
    '/api/v1/collaboration-invites/redeem',
    ids.outsider,
    { code: revokedInvite.body.invite.code, joinRequestId: 'revoked-join' },
  );
  assert.equal(revokedRedeem.status, 404);
  assert.equal(errorCode(revokedRedeem), 'INVITE_INVALID');

  const expiredInvite = await harness.request(
    'POST',
    `/api/v1/sessions/${ids.session}/invites`,
    ids.owner,
    { role: 'viewer' },
    'invite-to-expire',
  );
  harness.db.prepare(`
    UPDATE collaboration_invites SET expires_at = ? WHERE id = ?
  `).run('2000-01-01T00:00:00.000Z', expiredInvite.body.invite.inviteId);
  const expiredRedeem = await harness.request(
    'POST',
    '/api/v1/collaboration-invites/redeem',
    ids.outsider,
    { code: expiredInvite.body.invite.code, joinRequestId: 'expired-join' },
  );
  assert.equal(expiredRedeem.status, 404);
  assert.equal(errorCode(expiredRedeem), 'INVITE_INVALID');
});

test('enabled invite redemption rate limiting caps repeated account attempts', async (t) => {
  config.rateLimitEnabled = true;
  const harness = await createHarness();
  t.after(async () => {
    config.rateLimitEnabled = false;
    await harness.close();
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await harness.request(
      'POST',
      '/api/v1/collaboration-invites/redeem',
      ids.outsider,
      { code: '00000-00000', joinRequestId: `rate-attempt-${attempt}` },
    );
    assert.equal(response.status, 404);
    assert.equal(errorCode(response), 'INVITE_INVALID');
  }
  const limited = await harness.request(
    'POST',
    '/api/v1/collaboration-invites/redeem',
    ids.outsider,
    { code: '00000-00000', joinRequestId: 'rate-attempt-limited' },
  );
  assert.equal(limited.status, 429);
  assert.equal(errorCode(limited), 'RATE_LIMITED');
});
