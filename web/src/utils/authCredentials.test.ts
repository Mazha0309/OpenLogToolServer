import { describe, expect, it } from 'vitest';
import { isLegacyCompatibleLogin, submittedUsername } from './authCredentials';

describe('legacy account sign-in compatibility', () => {
  it('preserves the exact legacy username at sign-in', () => {
    expect(submittedUsername('login', ' x ')).toBe(' x ');
    expect(submittedUsername('register', ' new-user ')).toBe('new-user');
    expect(submittedUsername('bootstrap', ' first-admin ')).toBe('first-admin');
  });

  it('uses relaxed fields only for an ordinary sign-in', () => {
    expect(isLegacyCompatibleLogin('login', false)).toBe(true);
    expect(isLegacyCompatibleLogin('login', true)).toBe(false);
    expect(isLegacyCompatibleLogin('register', false)).toBe(false);
    expect(isLegacyCompatibleLogin('bootstrap', false)).toBe(false);
  });
});
