import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import Database from 'better-sqlite3';
import { normalizeStableId, SessionRole } from './access';
import { AppError } from '../errors/app-error';
import { rejectUnknownKeys } from '../utils/validation';

export const COLLABORATION_AUDIT_ACTIONS = [
  'membership.role.updated',
  'membership.removed',
  'ownership.transferred',
  'invite.created',
  'invite.redeemed',
  'invite.revoked',
  'session.deleted',
] as const;

export type CollaborationAuditAction = typeof COLLABORATION_AUDIT_ACTIONS[number];
type InviteRole = 'editor' | 'viewer';
type MembershipState = 'absent' | 'active' | 'removed';

interface AuditInputBase {
  sessionId: string;
  actorUserId: string;
  requestId: string;
  mutationId: string;
  occurredAt: string;
}

export type CollaborationAuditInput =
  | AuditInputBase & {
      action: 'membership.role.updated';
      targetUserId: string;
      beforeRole: SessionRole;
      beforeVersion: number;
      afterRole: SessionRole;
      afterVersion: number;
    }
  | AuditInputBase & {
      action: 'membership.removed';
      targetUserId: string;
      role: SessionRole;
      beforeVersion: number;
      afterVersion: number;
      removedAt: string;
    }
  | AuditInputBase & {
      action: 'ownership.transferred';
      targetUserId: string;
      previousOwnerBeforeVersion: number;
      previousOwnerAfterVersion: number;
      newOwnerBeforeRole: SessionRole;
      newOwnerBeforeVersion: number;
      newOwnerAfterVersion: number;
    }
  | AuditInputBase & {
      action: 'invite.created';
      inviteId: string;
      role: InviteRole;
      maxUses: number;
      usedCount: number;
      expiresAt: string;
    }
  | AuditInputBase & {
      action: 'invite.redeemed';
      targetUserId: string;
      inviteId: string;
      roleGranted: InviteRole;
      beforeUsedCount: number;
      afterUsedCount: number;
      beforeMembershipState: MembershipState;
      beforeMembershipRole: SessionRole | null;
      beforeMembershipVersion: number | null;
      afterMembershipState: MembershipState;
      afterMembershipRole: SessionRole | null;
      afterMembershipVersion: number | null;
    }
  | AuditInputBase & {
      action: 'invite.revoked';
      inviteId: string;
      role: InviteRole;
      maxUses: number;
      usedCount: number;
      expiresAt: string;
      revokedAt: string;
    }
  | AuditInputBase & {
      action: 'session.deleted';
      beforeStatus: string;
      beforeVersion: number;
      beforeEventSeq: number;
      afterStatus: string;
      afterVersion: number;
      afterEventSeq: number;
      deletedAt: string;
      revokedInviteCount: number;
      revokedWsTicketCount: number;
    };

interface CollaborationAuditRow {
  id: string;
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

interface AuditPayload {
  targetUserId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  details: Record<string, unknown>;
}

interface AuditFilters {
  action?: CollaborationAuditAction;
  actorUserId?: string;
  targetUserId?: string;
  from?: string;
  to?: string;
}

interface AuditCursor {
  v: 1;
  occurredAt: string;
  id: string;
  signature: string;
}

interface AuditQuery extends AuditFilters {
  cursor?: AuditCursor;
  limit: number;
}

const QUERY_KEYS = [
  'action',
  'actorUserId',
  'targetUserId',
  'from',
  'to',
  'cursor',
  'limit',
] as const;
const INPUT_BASE_KEYS = [
  'action',
  'sessionId',
  'actorUserId',
  'requestId',
  'mutationId',
  'occurredAt',
] as const;
const CURSOR_DOMAIN = 'openlogtool/collaboration-security-audit-cursor/v1';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validationError(message: string, details?: unknown): AppError {
  return new AppError(422, 'VALIDATION_FAILED', message, details);
}

function invalidStoredAudit(): never {
  throw new AppError(
    500,
    'COLLABORATION_AUDIT_INVALID',
    'Stored collaboration audit event is invalid',
  );
}

function invalidAuditInput(): never {
  throw new AppError(
    500,
    'COLLABORATION_AUDIT_INPUT_INVALID',
    'Collaboration audit input is invalid',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  return actual.length === keys.length && actual.every((key) => allowed.has(key));
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isRole(value: unknown): value is SessionRole {
  return value === 'owner' || value === 'editor' || value === 'viewer';
}

function isInviteRole(value: unknown): value is InviteRole {
  return value === 'editor' || value === 'viewer';
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function assertInputKeys(input: CollaborationAuditInput, keys: readonly string[]): void {
  if (!hasExactKeys(input as unknown as Record<string, unknown>, [
    ...INPUT_BASE_KEYS,
    ...keys,
  ])) {
    invalidAuditInput();
  }
}

function buildAuditPayload(input: CollaborationAuditInput): AuditPayload {
  switch (input.action) {
    case 'membership.role.updated':
      assertInputKeys(input, [
        'targetUserId',
        'beforeRole',
        'beforeVersion',
        'afterRole',
        'afterVersion',
      ]);
      return {
        targetUserId: input.targetUserId,
        before: { role: input.beforeRole, version: input.beforeVersion },
        after: { role: input.afterRole, version: input.afterVersion },
        details: {},
      };
    case 'membership.removed':
      assertInputKeys(input, [
        'targetUserId',
        'role',
        'beforeVersion',
        'afterVersion',
        'removedAt',
      ]);
      return {
        targetUserId: input.targetUserId,
        before: { role: input.role, version: input.beforeVersion, removedAt: null },
        after: {
          role: input.role,
          version: input.afterVersion,
          removedAt: input.removedAt,
        },
        details: {},
      };
    case 'ownership.transferred':
      assertInputKeys(input, [
        'targetUserId',
        'previousOwnerBeforeVersion',
        'previousOwnerAfterVersion',
        'newOwnerBeforeRole',
        'newOwnerBeforeVersion',
        'newOwnerAfterVersion',
      ]);
      return {
        targetUserId: input.targetUserId,
        before: {
          ownerUserId: input.actorUserId,
          previousOwnerRole: 'owner',
          previousOwnerVersion: input.previousOwnerBeforeVersion,
          newOwnerRole: input.newOwnerBeforeRole,
          newOwnerVersion: input.newOwnerBeforeVersion,
        },
        after: {
          ownerUserId: input.targetUserId,
          previousOwnerRole: 'editor',
          previousOwnerVersion: input.previousOwnerAfterVersion,
          newOwnerRole: 'owner',
          newOwnerVersion: input.newOwnerAfterVersion,
        },
        details: {},
      };
    case 'invite.created':
      assertInputKeys(input, ['inviteId', 'role', 'maxUses', 'usedCount', 'expiresAt']);
      return {
        targetUserId: null,
        before: null,
        after: {
          inviteId: input.inviteId,
          role: input.role,
          maxUses: input.maxUses,
          usedCount: input.usedCount,
          expiresAt: input.expiresAt,
        },
        details: {},
      };
    case 'invite.redeemed':
      assertInputKeys(input, [
        'targetUserId',
        'inviteId',
        'roleGranted',
        'beforeUsedCount',
        'afterUsedCount',
        'beforeMembershipState',
        'beforeMembershipRole',
        'beforeMembershipVersion',
        'afterMembershipState',
        'afterMembershipRole',
        'afterMembershipVersion',
      ]);
      return {
        targetUserId: input.targetUserId,
        before: {
          inviteId: input.inviteId,
          usedCount: input.beforeUsedCount,
          membershipState: input.beforeMembershipState,
          membershipRole: input.beforeMembershipRole,
          membershipVersion: input.beforeMembershipVersion,
        },
        after: {
          inviteId: input.inviteId,
          usedCount: input.afterUsedCount,
          membershipState: input.afterMembershipState,
          membershipRole: input.afterMembershipRole,
          membershipVersion: input.afterMembershipVersion,
        },
        details: { roleGranted: input.roleGranted },
      };
    case 'invite.revoked':
      assertInputKeys(input, [
        'inviteId',
        'role',
        'maxUses',
        'usedCount',
        'expiresAt',
        'revokedAt',
      ]);
      return {
        targetUserId: null,
        before: {
          inviteId: input.inviteId,
          role: input.role,
          maxUses: input.maxUses,
          usedCount: input.usedCount,
          expiresAt: input.expiresAt,
          revokedAt: null,
        },
        after: {
          inviteId: input.inviteId,
          role: input.role,
          maxUses: input.maxUses,
          usedCount: input.usedCount,
          expiresAt: input.expiresAt,
          revokedAt: input.revokedAt,
        },
        details: {},
      };
    case 'session.deleted':
      assertInputKeys(input, [
        'beforeStatus',
        'beforeVersion',
        'beforeEventSeq',
        'afterStatus',
        'afterVersion',
        'afterEventSeq',
        'deletedAt',
        'revokedInviteCount',
        'revokedWsTicketCount',
      ]);
      return {
        targetUserId: null,
        before: {
          status: input.beforeStatus,
          version: input.beforeVersion,
          eventSeq: input.beforeEventSeq,
          deletedAt: null,
        },
        after: {
          status: input.afterStatus,
          version: input.afterVersion,
          eventSeq: input.afterEventSeq,
          deletedAt: input.deletedAt,
        },
        details: {
          revokedInviteCount: input.revokedInviteCount,
          revokedWsTicketCount: input.revokedWsTicketCount,
        },
      };
  }
}

function parseAuditObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) invalidStoredAudit();
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return invalidStoredAudit();
  }
}

function validMembershipSnapshot(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, [
    'inviteId',
    'usedCount',
    'membershipState',
    'membershipRole',
    'membershipVersion',
  ])) return false;
  if (!isSafeId(value.inviteId) || !isNonNegativeInteger(value.usedCount)) return false;
  if (!['absent', 'active', 'removed'].includes(String(value.membershipState))) return false;
  if (value.membershipState === 'absent') {
    return value.membershipRole === null && value.membershipVersion === null;
  }
  return isRole(value.membershipRole) && isPositiveInteger(value.membershipVersion);
}

function validateStoredPayload(
  action: CollaborationAuditAction,
  actorUserId: string,
  targetUserId: string | null,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  details: Record<string, unknown> | null,
): asserts after is Record<string, unknown> {
  if (!after || !details) invalidStoredAudit();
  const requiresTarget = [
    'membership.role.updated',
    'membership.removed',
    'ownership.transferred',
    'invite.redeemed',
  ].includes(action);
  if ((requiresTarget && !isSafeId(targetUserId)) || (!requiresTarget && targetUserId !== null)) {
    invalidStoredAudit();
  }

  switch (action) {
    case 'membership.role.updated':
      if (
        !before ||
        !hasExactKeys(before, ['role', 'version']) ||
        !hasExactKeys(after, ['role', 'version']) ||
        !hasExactKeys(details, []) ||
        !isRole(before.role) ||
        !isRole(after.role) ||
        !isPositiveInteger(before.version) ||
        !isPositiveInteger(after.version) ||
        before.role === after.role
      ) invalidStoredAudit();
      return;
    case 'membership.removed':
      if (
        !before ||
        !hasExactKeys(before, ['role', 'version', 'removedAt']) ||
        !hasExactKeys(after, ['role', 'version', 'removedAt']) ||
        !hasExactKeys(details, []) ||
        !isRole(before.role) ||
        !isRole(after.role) ||
        !isPositiveInteger(before.version) ||
        !isPositiveInteger(after.version) ||
        before.removedAt !== null ||
        !isCanonicalTimestamp(after.removedAt)
      ) invalidStoredAudit();
      return;
    case 'ownership.transferred': {
      const keys = [
        'ownerUserId',
        'previousOwnerRole',
        'previousOwnerVersion',
        'newOwnerRole',
        'newOwnerVersion',
      ];
      if (
        !before ||
        !hasExactKeys(before, keys) ||
        !hasExactKeys(after, keys) ||
        !hasExactKeys(details, []) ||
        before.ownerUserId !== actorUserId ||
        after.ownerUserId !== targetUserId ||
        before.previousOwnerRole !== 'owner' ||
        after.previousOwnerRole !== 'editor' ||
        !isRole(before.newOwnerRole) ||
        after.newOwnerRole !== 'owner' ||
        !isPositiveInteger(before.previousOwnerVersion) ||
        !isPositiveInteger(after.previousOwnerVersion) ||
        !isPositiveInteger(before.newOwnerVersion) ||
        !isPositiveInteger(after.newOwnerVersion)
      ) invalidStoredAudit();
      return;
    }
    case 'invite.created':
      if (
        before !== null ||
        !hasExactKeys(after, ['inviteId', 'role', 'maxUses', 'usedCount', 'expiresAt']) ||
        !hasExactKeys(details, []) ||
        !isSafeId(after.inviteId) ||
        !isInviteRole(after.role) ||
        !isPositiveInteger(after.maxUses) ||
        !isNonNegativeInteger(after.usedCount) ||
        Number(after.usedCount) > Number(after.maxUses) ||
        !isCanonicalTimestamp(after.expiresAt)
      ) invalidStoredAudit();
      return;
    case 'invite.redeemed':
      if (
        !before ||
        targetUserId !== actorUserId ||
        !validMembershipSnapshot(before) ||
        !validMembershipSnapshot(after) ||
        !hasExactKeys(details, ['roleGranted']) ||
        !isInviteRole(details.roleGranted)
      ) invalidStoredAudit();
      return;
    case 'invite.revoked': {
      const keys = ['inviteId', 'role', 'maxUses', 'usedCount', 'expiresAt', 'revokedAt'];
      const validState = (value: Record<string, unknown>) =>
        isSafeId(value.inviteId) &&
        isInviteRole(value.role) &&
        isPositiveInteger(value.maxUses) &&
        isNonNegativeInteger(value.usedCount) &&
        Number(value.usedCount) <= Number(value.maxUses) &&
        isCanonicalTimestamp(value.expiresAt);
      if (
        !before ||
        !hasExactKeys(before, keys) ||
        !hasExactKeys(after, keys) ||
        !hasExactKeys(details, []) ||
        !validState(before) ||
        !validState(after) ||
        before.revokedAt !== null ||
        !isCanonicalTimestamp(after.revokedAt)
      ) invalidStoredAudit();
      return;
    }
    case 'session.deleted': {
      const keys = ['status', 'version', 'eventSeq', 'deletedAt'];
      if (
        !before ||
        !hasExactKeys(before, keys) ||
        !hasExactKeys(after, keys) ||
        !hasExactKeys(details, ['revokedInviteCount', 'revokedWsTicketCount']) ||
        !['closed', 'initializing'].includes(String(before.status)) ||
        after.status !== before.status ||
        !isPositiveInteger(before.version) ||
        !isPositiveInteger(after.version) ||
        !isNonNegativeInteger(before.eventSeq) ||
        !isNonNegativeInteger(after.eventSeq) ||
        before.deletedAt !== null ||
        !isCanonicalTimestamp(after.deletedAt) ||
        !isNonNegativeInteger(details.revokedInviteCount) ||
        !isNonNegativeInteger(details.revokedWsTicketCount)
      ) invalidStoredAudit();
      return;
    }
  }
}

function validatedStoredEvent(row: CollaborationAuditRow) {
  if (
    !isSafeId(row.id) ||
    !COLLABORATION_AUDIT_ACTIONS.includes(row.action as CollaborationAuditAction) ||
    !isSafeId(row.actor_user_id) ||
    (row.target_user_id !== null && !isSafeId(row.target_user_id)) ||
    !isSafeId(row.request_id) ||
    !isSafeId(row.mutation_id) ||
    !isCanonicalTimestamp(row.occurred_at)
  ) invalidStoredAudit();
  const action = row.action as CollaborationAuditAction;
  const before = parseAuditObject(row.before_json);
  const after = parseAuditObject(row.after_json);
  const details = parseAuditObject(row.details_json);
  validateStoredPayload(
    action,
    row.actor_user_id,
    row.target_user_id,
    before,
    after,
    details,
  );
  return {
    auditEventId: row.id,
    action,
    actorUserId: row.actor_user_id,
    targetUserId: row.target_user_id,
    before,
    after,
    details: details!,
    requestId: row.request_id,
    mutationId: row.mutation_id,
    occurredAt: row.occurred_at,
  };
}

export function appendCollaborationAudit(
  db: Database.Database,
  input: CollaborationAuditInput,
): string {
  if (!db.inTransaction) {
    throw new Error('Collaboration audit events must be appended inside the business transaction');
  }
  const payload = buildAuditPayload(input);
  const id = randomUUID();
  const row: CollaborationAuditRow = {
    id,
    action: input.action,
    actor_user_id: input.actorUserId,
    target_user_id: payload.targetUserId,
    request_id: input.requestId,
    mutation_id: input.mutationId,
    before_json: payload.before === null ? null : JSON.stringify(payload.before),
    after_json: JSON.stringify(payload.after),
    details_json: JSON.stringify(payload.details),
    occurred_at: input.occurredAt,
  };
  if (!isSafeId(input.sessionId)) invalidAuditInput();
  try {
    validatedStoredEvent(row);
  } catch (error) {
    if (error instanceof AppError && error.code === 'COLLABORATION_AUDIT_INVALID') {
      invalidAuditInput();
    }
    throw error;
  }
  db.prepare(`
    INSERT INTO collaboration_audit_events (
      id, session_id, action, actor_user_id, target_user_id,
      request_id, mutation_id, before_json, after_json, details_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.sessionId,
    input.action,
    input.actorUserId,
    payload.targetUserId,
    input.requestId,
    input.mutationId,
    row.before_json,
    row.after_json,
    row.details_json,
    input.occurredAt,
  );
  return id;
}

function optionalScalar(
  query: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = query[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw validationError(`${field} must be a single string`, { field });
  }
  return value;
}

function canonicalTimestamp(value: string, field: string): string {
  if (!isCanonicalTimestamp(value)) {
    throw validationError(`${field} must be a canonical ISO timestamp`, { field });
  }
  return value;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw validationError('limit must be a positive integer', { field: 'limit' });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_LIMIT) {
    throw validationError(`limit must be between 1 and ${MAX_LIMIT}`, {
      field: 'limit',
      min: 1,
      max: MAX_LIMIT,
    });
  }
  return parsed;
}

function cursorSignature(
  sessionId: string,
  ownerUserId: string,
  filters: AuditFilters,
  occurredAt: string,
  id: string,
  secret: string,
): string {
  const key = createHmac('sha256', secret)
    .update(`${CURSOR_DOMAIN}/key`)
    .digest();
  return createHmac('sha256', key)
    .update(CURSOR_DOMAIN)
    .update('\0')
    .update(JSON.stringify({
      sessionId,
      ownerUserId,
      action: filters.action ?? null,
      actorUserId: filters.actorUserId ?? null,
      targetUserId: filters.targetUserId ?? null,
      from: filters.from ?? null,
      to: filters.to ?? null,
      occurredAt,
      id,
    }))
    .digest('hex');
}

function signaturesEqual(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function decodeCursor(
  value: string,
  sessionId: string,
  ownerUserId: string,
  filters: AuditFilters,
  secret: string,
): AuditCursor {
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw validationError('cursor is invalid', { field: 'cursor' });
  }

  let decoded: Record<string, unknown>;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const raw = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!isRecord(raw)) throw new Error();
    decoded = raw;
    rejectUnknownKeys(decoded, ['v', 'occurredAt', 'id', 'signature']);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw validationError('cursor is invalid', { field: 'cursor' });
  }
  if (
    decoded.v !== 1 ||
    typeof decoded.occurredAt !== 'string' ||
    typeof decoded.id !== 'string' ||
    typeof decoded.signature !== 'string'
  ) {
    throw validationError('cursor is invalid', { field: 'cursor' });
  }
  const cursor: AuditCursor = {
    v: 1,
    occurredAt: canonicalTimestamp(decoded.occurredAt, 'cursor'),
    id: normalizeStableId(decoded.id, 'cursor'),
    signature: decoded.signature,
  };
  const expected = cursorSignature(
    sessionId,
    ownerUserId,
    filters,
    cursor.occurredAt,
    cursor.id,
    secret,
  );
  if (!signaturesEqual(cursor.signature, expected)) {
    throw validationError('cursor is invalid or does not match the requested filters', {
      field: 'cursor',
    });
  }
  return cursor;
}

function encodeCursor(
  row: CollaborationAuditRow,
  sessionId: string,
  ownerUserId: string,
  filters: AuditFilters,
  secret: string,
): string {
  const cursor: AuditCursor = {
    v: 1,
    occurredAt: row.occurred_at,
    id: row.id,
    signature: cursorSignature(
      sessionId,
      ownerUserId,
      filters,
      row.occurred_at,
      row.id,
      secret,
    ),
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function parseQuery(
  rawQuery: Record<string, unknown>,
  sessionId: string,
  ownerUserId: string,
  secret: string,
): AuditQuery {
  rejectUnknownKeys(rawQuery, QUERY_KEYS);
  const rawAction = optionalScalar(rawQuery, 'action');
  if (
    rawAction !== undefined &&
    !COLLABORATION_AUDIT_ACTIONS.includes(rawAction as CollaborationAuditAction)
  ) {
    throw validationError('action is not a supported collaboration audit action', {
      field: 'action',
      allowed: COLLABORATION_AUDIT_ACTIONS,
    });
  }
  const rawActor = optionalScalar(rawQuery, 'actorUserId');
  const rawTarget = optionalScalar(rawQuery, 'targetUserId');
  const rawFrom = optionalScalar(rawQuery, 'from');
  const rawTo = optionalScalar(rawQuery, 'to');
  const filters: AuditFilters = {
    ...(rawAction !== undefined
      ? { action: rawAction as CollaborationAuditAction }
      : {}),
    ...(rawActor !== undefined
      ? { actorUserId: normalizeStableId(rawActor, 'actorUserId') }
      : {}),
    ...(rawTarget !== undefined
      ? { targetUserId: normalizeStableId(rawTarget, 'targetUserId') }
      : {}),
    ...(rawFrom !== undefined ? { from: canonicalTimestamp(rawFrom, 'from') } : {}),
    ...(rawTo !== undefined ? { to: canonicalTimestamp(rawTo, 'to') } : {}),
  };
  if (filters.from && filters.to && filters.from >= filters.to) {
    throw validationError('from must be earlier than to', { fields: ['from', 'to'] });
  }
  const rawCursor = optionalScalar(rawQuery, 'cursor');
  return {
    ...filters,
    limit: parseLimit(optionalScalar(rawQuery, 'limit')),
    ...(rawCursor !== undefined
      ? { cursor: decodeCursor(rawCursor, sessionId, ownerUserId, filters, secret) }
      : {}),
  };
}

export function readCollaborationAuditPage(
  db: Database.Database,
  input: {
    sessionId: string;
    ownerUserId: string;
    rawQuery: Record<string, unknown>;
    cursorSecret: string;
  },
) {
  const query = parseQuery(
    input.rawQuery,
    input.sessionId,
    input.ownerUserId,
    input.cursorSecret,
  );
  const clauses = ['session_id = ?'];
  const parameters: Array<string | number> = [input.sessionId];
  if (query.action) {
    clauses.push('action = ?');
    parameters.push(query.action);
  }
  if (query.actorUserId) {
    clauses.push('actor_user_id = ?');
    parameters.push(query.actorUserId);
  }
  if (query.targetUserId) {
    clauses.push('target_user_id = ?');
    parameters.push(query.targetUserId);
  }
  if (query.from) {
    clauses.push('occurred_at >= ?');
    parameters.push(query.from);
  }
  if (query.to) {
    clauses.push('occurred_at < ?');
    parameters.push(query.to);
  }
  if (query.cursor) {
    clauses.push('(occurred_at < ? OR (occurred_at = ? AND id < ?))');
    parameters.push(query.cursor.occurredAt, query.cursor.occurredAt, query.cursor.id);
  }
  const rows = db.prepare(`
    SELECT
      id, action, actor_user_id, target_user_id, request_id, mutation_id,
      before_json, after_json, details_json, occurred_at
    FROM collaboration_audit_events
    WHERE ${clauses.join(' AND ')}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `).all(...parameters, query.limit + 1) as CollaborationAuditRow[];
  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const filters: AuditFilters = {
    ...(query.action !== undefined ? { action: query.action } : {}),
    ...(query.actorUserId !== undefined ? { actorUserId: query.actorUserId } : {}),
    ...(query.targetUserId !== undefined ? { targetUserId: query.targetUserId } : {}),
    ...(query.from !== undefined ? { from: query.from } : {}),
    ...(query.to !== undefined ? { to: query.to } : {}),
  };
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(validatedStoredEvent),
    pageInfo: {
      limit: query.limit,
      hasMore,
      nextCursor: hasMore && last
        ? encodeCursor(
            last,
            input.sessionId,
            input.ownerUserId,
            filters,
            input.cursorSecret,
          )
        : null,
    },
  };
}
