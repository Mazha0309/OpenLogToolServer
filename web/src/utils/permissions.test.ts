import { describe, expect, it } from 'vitest';
import { canEditOwnLog, canManageSession } from './permissions';

describe('member log permissions', () => {
  it('allows an owner or editor to change only their own log in an active session', () => {
    expect(canEditOwnLog('owner', 'active', { createdBy: 'me' }, 'me')).toBe(true);
    expect(canEditOwnLog('editor', 'active', { createdBy: 'me' }, 'me')).toBe(true);
    expect(canEditOwnLog('editor', 'active', { createdBy: 'someone-else' }, 'me')).toBe(false);
  });

  it('keeps viewer, closed-session and legacy authorless logs read-only', () => {
    expect(canEditOwnLog('viewer', 'active', { createdBy: 'me' }, 'me')).toBe(false);
    expect(canEditOwnLog('owner', 'closed', { createdBy: 'me' }, 'me')).toBe(false);
    expect(canEditOwnLog('owner', 'active', { createdBy: null }, 'me')).toBe(false);
  });

  it('treats the server canMutate flag as authoritative', () => {
    expect(canEditOwnLog('owner', 'active', { createdBy: 'me', canMutate: false }, 'me')).toBe(false);
    expect(canEditOwnLog('viewer', 'closed', { createdBy: null, canMutate: true }, 'me')).toBe(true);
  });

  it('reserves session management for the owner', () => {
    expect(canManageSession('owner')).toBe(true);
    expect(canManageSession('editor')).toBe(false);
    expect(canManageSession('viewer')).toBe(false);
  });
});
