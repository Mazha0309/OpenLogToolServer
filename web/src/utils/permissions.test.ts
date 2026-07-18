import { describe, expect, it } from 'vitest';
import { canEditLog, canManageSession } from './permissions';

describe('member log permissions', () => {
  it('allows an owner or editor to change any log in an active session', () => {
    expect(canEditLog('owner', 'active', { createdBy: 'someone-else' })).toBe(true);
    expect(canEditLog('editor', 'active', { createdBy: 'someone-else' })).toBe(true);
    expect(canEditLog('editor', 'active', { createdBy: null })).toBe(true);
  });

  it('keeps viewers and closed sessions read-only', () => {
    expect(canEditLog('viewer', 'active', { createdBy: 'me' })).toBe(false);
    expect(canEditLog('owner', 'closed', { createdBy: 'me' })).toBe(false);
  });

  it('treats the server canMutate flag as authoritative', () => {
    expect(canEditLog('owner', 'active', { createdBy: 'me', canMutate: false })).toBe(false);
    expect(canEditLog('viewer', 'closed', { createdBy: null, canMutate: true })).toBe(true);
  });

  it('reserves session management for the owner', () => {
    expect(canManageSession('owner')).toBe(true);
    expect(canManageSession('editor')).toBe(false);
    expect(canManageSession('viewer')).toBe(false);
  });
});
