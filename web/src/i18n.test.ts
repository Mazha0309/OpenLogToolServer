import { describe, expect, it } from 'vitest';
import { translate } from './i18n';

describe('translations', () => {
  it('supports both required locales', () => {
    expect(translate('zh-CN', 'auth.login')).toBe('登录');
    expect(translate('en-US', 'auth.login')).toBe('Sign in');
  });

  it('interpolates values without leaking placeholders', () => {
    expect(translate('zh-CN', 'overview.welcome', { name: 'BA1ABC' })).toContain('BA1ABC');
    expect(translate('en-US', 'sessions.logCount', { count: 12 })).toBe('12 logs');
  });
});
