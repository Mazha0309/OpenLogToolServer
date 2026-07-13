import { describe, expect, it } from 'vitest';
import { refreshRetryDelay } from './refreshRetry';

describe('refresh rotation retry contract', () => {
  it('uses the server delay for a recently rotated cookie', () => {
    expect(refreshRetryDelay({ code: 'REFRESH_TOKEN_ROTATED', details: { retryAfterMilliseconds: 240 } })).toBe(240);
  });

  it('defaults safely and never retries unrelated failures', () => {
    expect(refreshRetryDelay({ code: 'REFRESH_TOKEN_ROTATED' })).toBe(100);
    expect(refreshRetryDelay({ code: 'REFRESH_TOKEN_INVALID', details: { retryAfterMilliseconds: 1 } })).toBeNull();
  });
});
