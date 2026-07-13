import Database from 'better-sqlite3';
import { AppError } from '../errors/app-error';

export type SessionRole = 'owner' | 'editor' | 'viewer';

export interface SessionRow {
  id: string;
  title: string;
  status: string;
  owner_user_id: string;
  version: number;
  event_seq: number;
  min_retained_seq: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at: string | null;
}

export interface MembershipRow {
  id: string;
  session_id: string;
  user_id: string;
  role: SessionRole;
  version: number;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
}

export function normalizeStableId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a string`, { field });
  }
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} is not a valid stable identifier`, {
      field,
    });
  }
  return normalized;
}

export function findSession(db: Database.Database, sessionId: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | SessionRow
    | undefined;
}

export function findMembership(
  db: Database.Database,
  sessionId: string,
  userId: string,
): MembershipRow | undefined {
  return db.prepare(`
    SELECT * FROM session_members
    WHERE session_id = ? AND user_id = ? AND removed_at IS NULL
  `).get(sessionId, userId) as MembershipRow | undefined;
}

export function findMembershipIncludingRemoved(
  db: Database.Database,
  sessionId: string,
  userId: string,
): MembershipRow | undefined {
  return db.prepare(`
    SELECT * FROM session_members
    WHERE session_id = ? AND user_id = ?
  `).get(sessionId, userId) as MembershipRow | undefined;
}

export function requireMembership(
  db: Database.Database,
  sessionId: string,
  userId: string,
  roles?: readonly SessionRole[],
): { session: SessionRow; membership: MembershipRow } {
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
  if (session.deleted_at) {
    throw new AppError(410, 'SESSION_DELETED', 'Session has been deleted', {
      deletedAt: session.deleted_at,
      finalSeq: session.event_seq,
    });
  }
  if (roles && !roles.includes(membership.role)) {
    throw new AppError(403, 'FORBIDDEN', 'The current Session role cannot perform this action', {
      requiredRoles: roles,
      currentRole: membership.role,
    });
  }
  return { session, membership };
}

export function membershipDto(row: MembershipRow) {
  return {
    membershipId: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    role: row.role,
    version: row.version,
    joinedAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  };
}

export function sessionDto(row: SessionRow, role: SessionRole) {
  return {
    sessionId: row.id,
    title: row.title,
    status: row.status,
    version: row.version,
    role,
    highWatermarkSeq: row.event_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    deletedAt: row.deleted_at,
  };
}
