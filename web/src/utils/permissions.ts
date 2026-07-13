import type { LogRecord, SessionRole, SessionStatus } from '../types';

export function canEditOwnLog(
  role: SessionRole,
  status: SessionStatus | string,
  log: Pick<LogRecord, 'createdBy' | 'canMutate'>,
  currentUserId: string | undefined,
): boolean {
  if (typeof log.canMutate === 'boolean') return log.canMutate;
  return Boolean(
    currentUserId &&
    role !== 'viewer' &&
    status === 'active' &&
    log.createdBy === currentUserId,
  );
}

export function canManageSession(role: SessionRole): boolean {
  return role === 'owner';
}
