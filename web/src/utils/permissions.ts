import type { LogRecord, SessionRole, SessionStatus } from '../types';

export function canEditLog(
  role: SessionRole,
  status: SessionStatus | string,
  log: Pick<LogRecord, 'createdBy' | 'canMutate'>,
): boolean {
  if (typeof log.canMutate === 'boolean') return log.canMutate;
  return role !== 'viewer' && status === 'active';
}

export function canManageSession(role: SessionRole): boolean {
  return role === 'owner';
}
