import Database from 'better-sqlite3';
import { Router } from 'express';
import {
  findMembership,
  findSession,
  membershipDto,
  MembershipRow,
  normalizeStableId,
  sessionDto,
  SessionRole,
} from '../collaboration/access';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import {
  optionalString,
  rejectUnknownKeys,
  requireJsonObject,
  requireString,
} from '../utils/validation';
import {
  InviteV1Config,
  inviteV1Internals,
} from './session-members-v1';
import { createHash, randomUUID } from 'crypto';
import { getRealtimeHub } from '../collaboration/realtime';

export interface CollaborationInvitesV1Dependencies {
  db: Database.Database;
  config: InviteV1Config;
}

interface InviteRow {
  id: string;
  session_id: string;
  code_hash: string;
  link_token_hash: string | null;
  role: 'editor' | 'viewer';
  max_uses: number;
  used_count: number;
  expires_at: string;
  revoked_at: string | null;
}

interface RedemptionRow {
  id: string;
  invite_id: string;
  user_id: string;
  join_request_id: string;
  device_id: string | null;
  role_granted: 'editor' | 'viewer';
  redeemed_at: string;
  request_hash: string | null;
  response_json: string | null;
}

const ROLE_RANK: Record<SessionRole, number> = { viewer: 1, editor: 2, owner: 3 };

function normalizeCode(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (!/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/.test(normalized)) {
    throw new AppError(404, 'INVITE_INVALID', 'Invite is invalid or unavailable');
  }
  return normalized;
}

function effectiveRole(current: SessionRole, invited: 'editor' | 'viewer'): SessionRole {
  return ROLE_RANK[current] >= ROLE_RANK[invited] ? current : invited;
}

function readCredential(config: InviteV1Config, body: Record<string, unknown>): {
  column: 'code_hash' | 'link_token_hash';
  hash: string;
} {
  const code = body.code == null
    ? undefined
    : optionalString(body, 'code', { min: 10, max: 16 });
  const linkToken = body.linkToken == null
    ? undefined
    : optionalString(body, 'linkToken', { min: 22, max: 512, trim: false });
  if (Boolean(code) === Boolean(linkToken)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Provide exactly one of code or linkToken');
  }
  if (code) {
    return {
      column: 'code_hash',
      hash: inviteV1Internals.hashInviteCredential(
        config,
        'code',
        normalizeCode(code),
      ),
    };
  }
  return {
    column: 'link_token_hash',
    hash: inviteV1Internals.hashInviteCredential(config, 'link', linkToken!),
  };
}

function credentialMatches(invite: InviteRow, credential: { column: string; hash: string }): boolean {
  return credential.column === 'code_hash'
    ? invite.code_hash === credential.hash
    : invite.link_token_hash === credential.hash;
}

function redemptionRequestHash(
  userId: string,
  joinRequestId: string,
  deviceId: string | undefined,
  credential: { column: string; hash: string },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        userId,
        joinRequestId,
        deviceId: deviceId ?? null,
        credentialColumn: credential.column,
        credentialHash: credential.hash,
      }),
    )
    .digest('hex');
}

function parseStoredRedemptionResponse(row: RedemptionRow): unknown | undefined {
  if (!row.response_json) return undefined;
  try {
    const parsed: unknown = JSON.parse(row.response_json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function redemptionResponse(
  db: Database.Database,
  invite: InviteRow,
  userId: string,
  roleGranted: 'editor' | 'viewer',
) {
  const membership = findMembership(db, invite.session_id, userId);
  const session = findSession(db, invite.session_id);
  if (!membership || !session) {
    throw new AppError(409, 'REDEMPTION_STATE_INVALID', 'Invite redemption state is incomplete');
  }
  return {
    membership: membershipDto(membership),
    roleGranted,
    session: sessionDto(session, membership.role),
    highWatermarkSeq: session.event_seq,
  };
}

export function createCollaborationInvitesV1Router(
  dependencies: CollaborationInvitesV1Dependencies,
): Router {
  const { db, config } = dependencies;
  const router = Router();
  const realtime = getRealtimeHub(db);
  router.use(createAccessTokenMiddleware(config));
  const ipLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 20,
    message: 'Too many invite redemption attempts',
  });
  const accountLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 10,
    keyGenerator: (req) => (req as V1AuthRequest).auth?.userId || 'unknown',
    message: 'Too many invite redemption attempts',
  });

  router.post(
    '/redeem',
    ...(config.rateLimitEnabled ? [ipLimiter, accountLimiter] : []),
    (req: V1AuthRequest, res, next) => {
      try {
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['code', 'linkToken', 'joinRequestId', 'deviceId']);
        inviteV1Internals.assertInviteConfig(config, db);
        const joinRequestId = normalizeStableId(
          requireString(body, 'joinRequestId', { min: 1, max: 128 }),
          'joinRequestId',
        );
        const idempotencyKey = req.header('idempotency-key')?.trim();
        if (idempotencyKey && idempotencyKey !== joinRequestId) {
          throw new AppError(
            409,
            'IDEMPOTENCY_KEY_MISMATCH',
            'Idempotency-Key must match joinRequestId for invite redemption',
          );
        }
        const deviceIdValue = optionalString(body, 'deviceId', { min: 1, max: 128 });
        if (deviceIdValue !== undefined) normalizeStableId(deviceIdValue, 'deviceId');
        const credential = readCredential(config, body);
        const userId = req.auth!.userId;
        const requestHash = redemptionRequestHash(
          userId,
          joinRequestId,
          deviceIdValue,
          credential,
        );
        const now = new Date().toISOString();

        const result = db.transaction(() => {
          const priorJoin = db.prepare(`
            SELECT * FROM invite_redemptions WHERE join_request_id = ?
          `).get(joinRequestId) as RedemptionRow | undefined;
          if (priorJoin) {
            const storedResponse = parseStoredRedemptionResponse(priorJoin);
            if (priorJoin.request_hash && storedResponse) {
              if (priorJoin.user_id !== userId || priorJoin.request_hash !== requestHash) {
                throw new AppError(
                  409,
                  'JOIN_REQUEST_ID_REUSED',
                  'joinRequestId was already used for a different redemption',
                );
              }
              return { body: storedResponse };
            }
            const priorInvite = db.prepare('SELECT * FROM collaboration_invites WHERE id = ?').get(
              priorJoin.invite_id,
            ) as InviteRow | undefined;
            if (
              priorJoin.user_id !== userId ||
              !priorInvite ||
              !credentialMatches(priorInvite, credential)
            ) {
              throw new AppError(
                409,
                'JOIN_REQUEST_ID_REUSED',
                'joinRequestId was already used for a different redemption',
              );
            }
            return {
              body: redemptionResponse(db, priorInvite, userId, priorJoin.role_granted),
            };
          }

          const invite = db.prepare(`
            SELECT * FROM collaboration_invites WHERE ${credential.column} = ?
          `).get(credential.hash) as InviteRow | undefined;
          if (!invite) throw new AppError(404, 'INVITE_INVALID', 'Invite is invalid or unavailable');

          const session = findSession(db, invite.session_id);
          if (!session || session.deleted_at) {
            throw new AppError(404, 'INVITE_INVALID', 'Invite is invalid or unavailable');
          }
          if (
            invite.revoked_at ||
            Date.parse(invite.expires_at) <= Date.now() ||
            invite.used_count >= invite.max_uses
          ) {
            throw new AppError(404, 'INVITE_INVALID', 'Invite is invalid or unavailable');
          }
          const priorRedemption = db.prepare(`
            SELECT * FROM invite_redemptions WHERE invite_id = ? AND user_id = ?
          `).get(invite.id, userId) as RedemptionRow | undefined;
          if (priorRedemption) {
            throw new AppError(
              409,
              'ALREADY_REDEEMED',
              'This account already redeemed the invite with a different joinRequestId',
            );
          }
          const consume = db.prepare(`
            UPDATE collaboration_invites
            SET used_count = used_count + 1
            WHERE id = ?
              AND revoked_at IS NULL
              AND expires_at > ?
              AND used_count < max_uses
          `).run(invite.id, now);
          if (consume.changes !== 1) {
            throw new AppError(404, 'INVITE_INVALID', 'Invite is invalid or unavailable');
          }

          const existing = db.prepare(`
            SELECT * FROM session_members WHERE session_id = ? AND user_id = ?
          `).get(invite.session_id, userId) as MembershipRow | undefined;
          let membershipId: string;
          let changedExistingRole = false;
          if (!existing) {
            membershipId = randomUUID();
            db.prepare(`
              INSERT INTO session_members (
                id, session_id, user_id, role, version, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 1, ?, ?)
            `).run(membershipId, invite.session_id, userId, invite.role, now, now);
          } else {
            membershipId = existing.id;
            const role = existing.removed_at
              ? invite.role
              : effectiveRole(existing.role, invite.role);
            changedExistingRole = !existing.removed_at && role !== existing.role;
            db.prepare(`
              UPDATE session_members
              SET role = ?, removed_at = NULL, removed_by = NULL,
                  version = version + 1, updated_at = ?
              WHERE id = ?
            `).run(role, now, existing.id);
          }

          const response = redemptionResponse(db, invite, userId, invite.role);
          db.prepare(`
            INSERT INTO invite_redemptions (
              id, invite_id, user_id, membership_id, join_request_id,
              device_id, role_granted, redeemed_at, request_hash, response_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            invite.id,
            userId,
            membershipId,
            joinRequestId,
            deviceIdValue ?? null,
            invite.role,
            now,
            requestHash,
            JSON.stringify(response),
          );
          const currentMembership = findMembership(db, invite.session_id, userId)!;
          return {
            body: response,
            ...(changedExistingRole
              ? {
                  roleChange: {
                    sessionId: invite.session_id,
                    userId,
                    role: currentMembership.role,
                    version: currentMembership.version,
                  },
                }
              : {}),
          };
        }).immediate();

        if ('roleChange' in result && result.roleChange) {
          realtime.roleChanged(
            result.roleChange.sessionId,
            result.roleChange.userId,
            result.roleChange.role,
            result.roleChange.version,
          );
        }
        res.status(201).json(result.body);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
