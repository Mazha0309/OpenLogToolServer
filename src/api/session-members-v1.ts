import { createHash, createHmac, randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { Response, Router } from 'express';
import { AppConfig } from '../config';
import {
  computeRequestHash,
  readStoredResponse,
  requireIdempotencyKey,
  storeResponse,
} from '../collaboration/idempotency';
import {
  appendCollaborationAudit,
  readCollaborationAuditPage,
} from '../collaboration/audit';
import {
  findMembership,
  findMembershipIncludingRemoved,
  findSession,
  membershipDto,
  MembershipRow,
  normalizeStableId,
  SessionRole,
} from '../collaboration/access';
import { AppError } from '../errors/app-error';
import { getRealtimeHub } from '../collaboration/realtime';
import { getLiveDraftLockManager } from '../collaboration/live-draft';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { getRequestId } from '../middleware/request-id';
import { rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';

export interface InviteV1Config extends AppConfig {
  inviteHmacKey: string;
}

export interface SessionMembershipV1Dependencies {
  db: Database.Database;
  config: InviteV1Config;
}

interface MemberListRow extends MembershipRow {
  username: string;
}

interface InviteRow {
  id: string;
  session_id: string;
  code_hash: string;
  link_token_hash: string | null;
  code_hint: string;
  role: 'editor' | 'viewer';
  max_uses: number;
  used_count: number;
  expires_at: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function runImmediate<T>(db: Database.Database, operation: () => T): T {
  return db.transaction(operation).immediate();
}

function membershipWithUsernameDto(row: MemberListRow) {
  return { ...membershipDto(row), username: row.username };
}

function inviteDto(row: InviteRow) {
  return {
    inviteId: row.id,
    sessionId: row.session_id,
    codeHint: row.code_hint,
    role: row.role,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

function readRole(body: Record<string, unknown>, allowed: readonly SessionRole[]): SessionRole {
  const role = requireString(body, 'role', { min: 5, max: 6 }) as SessionRole;
  if (!allowed.includes(role)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'role is not allowed for this operation', {
      field: 'role',
      allowed,
    });
  }
  return role;
}

function optionalInteger(
  body: Record<string, unknown>,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = body[field];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      `${field} must be an integer between ${minimum} and ${maximum}`,
      { field, minimum, maximum },
    );
  }
  return Number(value);
}

function optionalBoolean(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a boolean`, { field });
  }
  return value;
}

function requireActiveMembership(
  db: Database.Database,
  sessionId: string,
  userId: string,
  roles?: readonly SessionRole[],
): { membership: MembershipRow } {
  const session = findSession(db, sessionId);
  const membership = db.prepare(`
    SELECT * FROM session_members WHERE session_id = ? AND user_id = ?
  `).get(sessionId, userId) as MembershipRow | undefined;
  if (!session || !membership) {
    throw new AppError(404, 'NOT_FOUND', 'Session not found');
  }
  if (membership.removed_at) {
    throw new AppError(403, 'MEMBERSHIP_REVOKED', 'Session membership has been revoked');
  }
  if (session.deleted_at) {
    throw new AppError(410, 'SESSION_DELETED', 'Session has been deleted', {
      deletedAt: session.deleted_at,
      finalSeq: session.event_seq,
    });
  }
  if (roles && !roles.includes(membership.role)) {
    throw new AppError(403, 'FORBIDDEN', 'The current Session role cannot perform this action');
  }
  return { membership };
}

function requireOwner(db: Database.Database, sessionId: string, userId: string) {
  return requireActiveMembership(db, sessionId, userId, ['owner']);
}

function requireAuditOwner(db: Database.Database, sessionId: string, userId: string): void {
  const session = findSession(db, sessionId);
  const membership = findMembershipIncludingRemoved(db, sessionId, userId);
  if (!session || !membership) {
    throw new AppError(404, 'NOT_FOUND', 'Resource not found');
  }
  if (membership.removed_at) {
    throw new AppError(403, 'MEMBERSHIP_REVOKED', 'Session membership has been revoked', {
      removedAt: membership.removed_at,
    });
  }
  if (membership.role !== 'owner') {
    throw new AppError(403, 'FORBIDDEN', 'Only the current Session owner can read audit events');
  }
}

function requestIdentity(req: V1AuthRequest): string {
  return req.auth!.userId;
}

function hmac(config: InviteV1Config, domain: string, value: string): Buffer {
  return createHmac('sha256', config.inviteHmacKey).update(`${domain}\0${value}`).digest();
}

function deriveInviteCode(config: InviteV1Config, inviteId: string): string {
  const digest = hmac(config, 'invite-code-secret-v1', inviteId);
  let code = '';
  for (let index = 0; index < 10; index += 1) {
    code += CROCKFORD_ALPHABET[digest[index] & 31];
  }
  return code;
}

function formatInviteCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function deriveLinkToken(config: InviteV1Config, inviteId: string): string {
  return hmac(config, 'invite-link-secret-v1', inviteId).toString('base64url');
}

function hashInviteCredential(config: InviteV1Config, domain: 'code' | 'link', value: string): string {
  return hmac(config, `invite-${domain}-lookup-v1`, value).toString('hex');
}

function assertInviteConfig(config: InviteV1Config, db: Database.Database): void {
  if (Buffer.byteLength(config.inviteHmacKey || '', 'utf8') < 32) {
    throw new AppError(
      503,
      'INVITE_HMAC_NOT_CONFIGURED',
      'Invite creation and redemption are not configured',
    );
  }
  const fingerprint = createHash('sha256')
    .update('openlogtool-invite-hmac-key-v1\0')
    .update(config.inviteHmacKey)
    .digest('hex');
  db.prepare(`
    UPDATE server_settings
    SET invite_hmac_fingerprint = ?
    WHERE id = 1 AND invite_hmac_fingerprint IS NULL
  `).run(fingerprint);
  const bound = db.prepare(`
    SELECT invite_hmac_fingerprint FROM server_settings WHERE id = 1
  `).get() as { invite_hmac_fingerprint?: string | null } | undefined;
  if (bound?.invite_hmac_fingerprint !== fingerprint) {
    throw new AppError(
      503,
      'INVITE_HMAC_KEY_CHANGED',
      'The invite HMAC key does not match this server database',
    );
  }
}

function idempotencyContext(req: V1AuthRequest, body: unknown = req.body) {
  const mutationId = requireIdempotencyKey(req);
  return {
    mutationId,
    requestHash: computeRequestHash(req.method, req.baseUrl + req.path, body),
    userId: requestIdentity(req),
    requestId: getRequestId(req),
  };
}

function sendStored(
  res: Response,
  stored: { status: number; body: unknown; replayed?: boolean },
) {
  if (stored.replayed) res.setHeader('Idempotent-Replay', 'true');
  res.status(stored.status).json(stored.body);
}

export function createSessionMembershipV1Router(
  dependencies: SessionMembershipV1Dependencies,
): Router {
  const { db, config } = dependencies;
  const router = Router();
  const realtime = getRealtimeHub(db);
  router.use(createAccessTokenMiddleware(config));

  router.get('/:id/membership', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.id, 'sessionId');
      const { membership } = requireActiveMembership(db, sessionId, requestIdentity(req));
      res.json({ membership: membershipDto(membership) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id/membership', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.id, 'sessionId');
      const body = req.body === undefined ? {} : requireJsonObject(req.body);
      rejectUnknownKeys(body, []);
      const context = idempotencyContext(req, body);
      const result = runImmediate(db, () => {
        const session = findSession(db, sessionId);
        const membership = findMembershipIncludingRemoved(db, sessionId, context.userId);
        if (!session || !membership) {
          throw new AppError(404, 'NOT_FOUND', 'Resource not found');
        }
        const stored = readStoredResponse(
          db,
          context.mutationId,
          context.userId,
          context.requestHash,
        );
        if (stored) return { ...stored, replayed: true };
        if (membership.removed_at) {
          throw new AppError(403, 'MEMBERSHIP_REVOKED', 'Session membership has been revoked', {
            removedAt: membership.removed_at,
          });
        }
        if (session.deleted_at) {
          throw new AppError(410, 'SESSION_DELETED', 'Session has been deleted', {
            deletedAt: session.deleted_at,
            finalSeq: session.event_seq,
          });
        }
        if (membership.role === 'owner') {
          throw new AppError(
            409,
            'OWNER_TRANSFER_REQUIRED',
            'Transfer ownership before leaving the Session',
          );
        }

        const now = new Date().toISOString();
        const removed = db.prepare(`
          UPDATE session_members
          SET removed_at = ?, removed_by = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND removed_at IS NULL
        `).run(now, context.userId, now, membership.id);
        if (removed.changes !== 1) {
          throw new AppError(409, 'MEMBERSHIP_CHANGED', 'Session membership changed concurrently');
        }
        const updated = findMembershipIncludingRemoved(db, sessionId, context.userId)!;
        db.prepare(`
          DELETE FROM live_draft_device_state
          WHERE session_id = ? AND user_id = ?
        `).run(sessionId, context.userId);
        const response = { left: true, membership: membershipDto(updated) };
        appendCollaborationAudit(db, {
          action: 'membership.removed',
          sessionId,
          actorUserId: context.userId,
          targetUserId: context.userId,
          requestId: context.requestId,
          mutationId: context.mutationId,
          occurredAt: now,
          role: membership.role,
          beforeVersion: membership.version,
          afterVersion: updated.version,
          removedAt: now,
        });
        storeResponse(db, {
          ...context,
          sessionId,
          status: 200,
          body: response,
        });
        return {
          status: 200,
          body: response,
          leftUserId: context.userId,
        };
      });
      if ('leftUserId' in result && typeof result.leftUserId === 'string') {
        const released = getLiveDraftLockManager(db).clearUser(sessionId, result.leftUserId);
        if (released.length > 0) {
          realtime.publishControl({
            type: 'liveDraft.lockChanged',
            sessionId,
            occurredAt: new Date().toISOString(),
            action: 'membershipRevoked',
            fields: released.map((lock) => lock.field),
          });
        }
        realtime.revoke(sessionId, result.leftUserId);
      }
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/members', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.id, 'sessionId');
      requireOwner(db, sessionId, requestIdentity(req));
      const members = db.prepare(`
        SELECT sm.*, u.username
        FROM session_members sm
        JOIN users u ON u.id = sm.user_id
        WHERE sm.session_id = ? AND sm.removed_at IS NULL
        ORDER BY CASE sm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                 sm.created_at, sm.user_id
      `).all(sessionId) as MemberListRow[];
      res.json({ members: members.map(membershipWithUsernameDto) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/audit-events', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.id, 'sessionId');
      const ownerUserId = requestIdentity(req);
      const response = db.transaction(() => {
        requireAuditOwner(db, sessionId, ownerUserId);
        return readCollaborationAuditPage(db, {
          sessionId,
          ownerUserId,
          rawQuery: req.query as Record<string, unknown>,
          cursorSecret: config.jwtSecret,
        });
      }).deferred();
      res.setHeader('Cache-Control', 'no-store');
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id/members/:userId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.id, 'sessionId');
      const targetUserId = normalizeStableId(req.params.userId, 'userId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['role']);
      const role = readRole(body, ['editor', 'viewer']);
      const context = idempotencyContext(req);

      const result = runImmediate(db, () => {
        requireOwner(db, sessionId, context.userId);
        const stored = readStoredResponse(db, context.mutationId, context.userId, context.requestHash);
        if (stored) return stored;
        const target = findMembership(db, sessionId, targetUserId);
        if (!target) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Session member not found');
        if (target.role === 'owner') {
          throw new AppError(
            409,
            'OWNER_TRANSFER_REQUIRED',
            'Use transfer-ownership to change the owner role',
          );
        }
        const changed = target.role !== role;
        const now = new Date().toISOString();
        if (changed) {
          db.prepare(`
            UPDATE session_members
            SET role = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND removed_at IS NULL
          `).run(role, now, target.id);
          if (role === 'viewer') {
            db.prepare(`
              DELETE FROM live_draft_device_state
              WHERE session_id = ? AND user_id = ?
            `).run(sessionId, targetUserId);
          }
        }
        const updated = findMembership(db, sessionId, targetUserId)!;
        const response = { membership: membershipDto(updated) };
        if (changed) {
          appendCollaborationAudit(db, {
            action: 'membership.role.updated',
            sessionId,
            actorUserId: context.userId,
            targetUserId,
            requestId: context.requestId,
            mutationId: context.mutationId,
            occurredAt: now,
            beforeRole: target.role,
            beforeVersion: target.version,
            afterRole: updated.role,
            afterVersion: updated.version,
          });
        }
        storeResponse(db, {
          ...context,
          sessionId,
          status: 200,
          body: response,
        });
        return { status: 200, body: response, changed };
      });
      if ('changed' in result && result.changed) {
        const membership = (result.body as { membership: ReturnType<typeof membershipDto> }).membership;
        const released = getLiveDraftLockManager(db).clearUser(sessionId, targetUserId);
        if (released.length > 0) {
          realtime.publishControl({
            type: 'liveDraft.lockChanged',
            sessionId,
            occurredAt: new Date().toISOString(),
            action: 'membershipChanged',
            fields: released.map((lock) => lock.field),
          });
        }
        realtime.roleChanged(sessionId, targetUserId, membership.role, membership.version);
      }
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id/members/:userId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.id, 'sessionId');
      const targetUserId = normalizeStableId(req.params.userId, 'userId');
      const context = idempotencyContext(req);
      const result = runImmediate(db, () => {
        requireOwner(db, sessionId, context.userId);
        const stored = readStoredResponse(db, context.mutationId, context.userId, context.requestHash);
        if (stored) return stored;
        const target = findMembership(db, sessionId, targetUserId);
        if (!target) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Session member not found');
        if (target.role === 'owner') {
          throw new AppError(
            409,
            'OWNER_TRANSFER_REQUIRED',
            'Transfer ownership before removing the Session owner',
          );
        }
        const now = new Date().toISOString();
        db.prepare(`
          UPDATE session_members
          SET removed_at = ?, removed_by = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND removed_at IS NULL
        `).run(now, context.userId, now, target.id);
        db.prepare(`
          DELETE FROM live_draft_device_state
          WHERE session_id = ? AND user_id = ?
        `).run(sessionId, targetUserId);
        const response = { removed: true, sessionId, userId: targetUserId, removedAt: now };
        appendCollaborationAudit(db, {
          action: 'membership.removed',
          sessionId,
          actorUserId: context.userId,
          targetUserId,
          requestId: context.requestId,
          mutationId: context.mutationId,
          occurredAt: now,
          role: target.role,
          beforeVersion: target.version,
          afterVersion: target.version + 1,
          removedAt: now,
        });
        storeResponse(db, { ...context, sessionId, status: 200, body: response });
        return { status: 200, body: response, removedUserId: targetUserId };
      });
      if ('removedUserId' in result) {
        const released = getLiveDraftLockManager(db).clearUser(sessionId, result.removedUserId);
        if (released.length > 0) {
          realtime.publishControl({
            type: 'liveDraft.lockChanged',
            sessionId,
            occurredAt: new Date().toISOString(),
            action: 'membershipRevoked',
            fields: released.map((lock) => lock.field),
          });
        }
        realtime.revoke(sessionId, result.removedUserId);
      }
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/transfer-ownership', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.id, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['newOwnerUserId']);
      const newOwnerUserId = normalizeStableId(body.newOwnerUserId, 'newOwnerUserId');
      const context = idempotencyContext(req);
      const result = runImmediate(db, () => {
        const current = requireOwner(db, sessionId, context.userId);
        const stored = readStoredResponse(db, context.mutationId, context.userId, context.requestHash);
        if (stored) return stored;
        if (newOwnerUserId === context.userId) {
          const response = {
            sessionId,
            previousOwner: membershipDto(current.membership),
            owner: membershipDto(current.membership),
          };
          storeResponse(db, { ...context, sessionId, status: 200, body: response });
          return { status: 200, body: response };
        }
        const target = findMembership(db, sessionId, newOwnerUserId);
        if (!target) throw new AppError(404, 'MEMBER_NOT_FOUND', 'New owner must be an active member');
        const now = new Date().toISOString();
        db.prepare(`
          UPDATE session_members
          SET role = 'editor', version = version + 1, updated_at = ?
          WHERE id = ? AND role = 'owner' AND removed_at IS NULL
        `).run(now, current.membership.id);
        db.prepare(`
          UPDATE session_members
          SET role = 'owner', version = version + 1, updated_at = ?
          WHERE id = ? AND removed_at IS NULL
        `).run(now, target.id);
        // Ownership is access-control state and deliberately does not enter the
        // contiguous Session data-event stream. Membership versions carry this
        // change, so do not silently advance the canonical Session data version.
        const sessionUpdate = db.prepare(`
          UPDATE sessions
          SET owner_user_id = ?
          WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL
        `).run(newOwnerUserId, sessionId, context.userId);
        if (sessionUpdate.changes !== 1) {
          throw new AppError(409, 'OWNERSHIP_CHANGED', 'Session ownership changed concurrently');
        }
        const previousOwner = findMembership(db, sessionId, context.userId)!;
        const owner = findMembership(db, sessionId, newOwnerUserId)!;
        const response = {
          sessionId,
          previousOwner: membershipDto(previousOwner),
          owner: membershipDto(owner),
        };
        appendCollaborationAudit(db, {
          action: 'ownership.transferred',
          sessionId,
          actorUserId: context.userId,
          targetUserId: newOwnerUserId,
          requestId: context.requestId,
          mutationId: context.mutationId,
          occurredAt: now,
          previousOwnerBeforeVersion: current.membership.version,
          previousOwnerAfterVersion: previousOwner.version,
          newOwnerBeforeRole: target.role,
          newOwnerBeforeVersion: target.version,
          newOwnerAfterVersion: owner.version,
        });
        storeResponse(db, { ...context, sessionId, status: 200, body: response });
        return {
          status: 200,
          body: response,
          roleChanges: [
            { userId: context.userId, role: previousOwner.role, version: previousOwner.version },
            { userId: newOwnerUserId, role: owner.role, version: owner.version },
          ],
        };
      });
      if ('roleChanges' in result) {
        for (const change of result.roleChanges) {
          getLiveDraftLockManager(db).clearUser(sessionId, change.userId);
          realtime.roleChanged(sessionId, change.userId, change.role, change.version);
        }
        realtime.publishControl({
          type: 'liveDraft.lockChanged',
          sessionId,
          occurredAt: new Date().toISOString(),
          action: 'ownershipTransferred',
          locks: getLiveDraftLockManager(db).list(sessionId),
        });
      }
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/invites', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.id, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['role', 'expiresInHours', 'maxUses', 'includeLinkToken']);
      const role = readRole(body, ['editor', 'viewer']) as 'editor' | 'viewer';
      const expiresInHours = optionalInteger(body, 'expiresInHours', 24, 1, 24 * 30);
      const maxUses = optionalInteger(body, 'maxUses', 1, 1, 100);
      const includeLinkToken = optionalBoolean(body, 'includeLinkToken', false);
      assertInviteConfig(config, db);
      const context = idempotencyContext(req);

      const result = runImmediate(db, () => {
        requireOwner(db, sessionId, context.userId);
        const stored = readStoredResponse(db, context.mutationId, context.userId, context.requestHash);
        if (stored) return { ...stored, replayed: true };
        const now = new Date();
        const expiresAt = new Date(now.getTime() + expiresInHours * 3_600_000).toISOString();
        let inviteId = '';
        let code = '';
        for (let attempt = 0; attempt < 8; attempt += 1) {
          inviteId = randomUUID();
          code = deriveInviteCode(config, inviteId);
          const codeHash = hashInviteCredential(config, 'code', code);
          if (!db.prepare('SELECT 1 FROM collaboration_invites WHERE code_hash = ?').get(codeHash)) {
            break;
          }
          inviteId = '';
        }
        if (!inviteId) throw new AppError(503, 'INVITE_GENERATION_FAILED', 'Could not generate invite');
        const linkToken = includeLinkToken ? deriveLinkToken(config, inviteId) : undefined;
        db.prepare(`
          INSERT INTO collaboration_invites (
            id, session_id, code_hash, link_token_hash, code_hint, role,
            max_uses, used_count, expires_at, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `).run(
          inviteId,
          sessionId,
          hashInviteCredential(config, 'code', code),
          linkToken ? hashInviteCredential(config, 'link', linkToken) : null,
          code.slice(-4),
          role,
          maxUses,
          expiresAt,
          context.userId,
          now.toISOString(),
        );
        const row = db.prepare('SELECT * FROM collaboration_invites WHERE id = ?').get(
          inviteId,
        ) as InviteRow;
        const storedBody = { invite: inviteDto(row), includeLinkToken };
        appendCollaborationAudit(db, {
          action: 'invite.created',
          sessionId,
          actorUserId: context.userId,
          requestId: context.requestId,
          mutationId: context.mutationId,
          occurredAt: now.toISOString(),
          inviteId: row.id,
          role: row.role,
          maxUses: row.max_uses,
          usedCount: row.used_count,
          expiresAt: row.expires_at,
        });
        storeResponse(db, {
          ...context,
          sessionId,
          status: 201,
          body: storedBody,
        });
        return { status: 201, body: storedBody, replayed: false };
      });

      const storedBody = result.body as { invite: ReturnType<typeof inviteDto>; includeLinkToken: boolean };
      const inviteId = storedBody.invite.inviteId;
      const currentInvite = db.prepare(`
        SELECT * FROM collaboration_invites WHERE id = ? AND session_id = ?
      `).get(inviteId, sessionId) as InviteRow | undefined;
      if (
        !currentInvite ||
        currentInvite.revoked_at ||
        Date.parse(currentInvite.expires_at) <= Date.now() ||
        currentInvite.used_count >= currentInvite.max_uses
      ) {
        throw new AppError(409, 'INVITE_NOT_ACTIVE', 'Invite is no longer active');
      }
      const code = formatInviteCode(deriveInviteCode(config, inviteId));
      res.status(result.status).json({
        invite: {
          ...inviteDto(currentInvite),
          code,
          ...(storedBody.includeLinkToken
            ? { linkToken: deriveLinkToken(config, inviteId) }
            : {}),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/invites', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.id, 'sessionId');
      requireOwner(db, sessionId, requestIdentity(req));
      const rows = db.prepare(`
        SELECT * FROM collaboration_invites
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
      `).all(sessionId) as InviteRow[];
      res.json({ invites: rows.map(inviteDto) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id/invites/:inviteId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.id, 'sessionId');
      const inviteId = normalizeStableId(req.params.inviteId, 'inviteId');
      const context = idempotencyContext(req);
      const result = runImmediate(db, () => {
        requireOwner(db, sessionId, context.userId);
        const stored = readStoredResponse(db, context.mutationId, context.userId, context.requestHash);
        if (stored) return stored;
        const row = db.prepare(`
          SELECT * FROM collaboration_invites WHERE id = ? AND session_id = ?
        `).get(inviteId, sessionId) as InviteRow | undefined;
        if (!row) throw new AppError(404, 'INVITE_NOT_FOUND', 'Invite not found');
        const now = new Date().toISOString();
        db.prepare(`
          UPDATE collaboration_invites
          SET revoked_at = COALESCE(revoked_at, ?),
              revoked_by = CASE WHEN revoked_at IS NULL THEN ? ELSE revoked_by END
          WHERE id = ?
        `).run(now, context.userId, inviteId);
        const updated = db.prepare('SELECT * FROM collaboration_invites WHERE id = ?').get(
          inviteId,
        ) as InviteRow;
        const response = { invite: inviteDto(updated) };
        if (row.revoked_at === null) {
          appendCollaborationAudit(db, {
            action: 'invite.revoked',
            sessionId,
            actorUserId: context.userId,
            requestId: context.requestId,
            mutationId: context.mutationId,
            occurredAt: now,
            inviteId: row.id,
            role: row.role,
            maxUses: row.max_uses,
            usedCount: row.used_count,
            expiresAt: row.expires_at,
            revokedAt: now,
          });
        }
        storeResponse(db, { ...context, sessionId, status: 200, body: response });
        return { status: 200, body: response };
      });
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const inviteV1Internals = {
  assertInviteConfig,
  deriveInviteCode,
  deriveLinkToken,
  formatInviteCode,
  hashInviteCredential,
};
