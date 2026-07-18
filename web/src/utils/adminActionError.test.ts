import { describe, expect, it } from 'vitest';
import {
  adminDangerActionRecovery,
  adminActionErrorMessage,
  shouldReloadAfterAdminActionError,
} from './adminActionError';

describe('administrator action error presentation', () => {
  it('keeps both the server message and stable error code', () => {
    const error = {
      status: 409,
      code: 'LIVE_DRAFT_NOT_EMPTY',
      message: 'Commit or discard the live draft before closing the Session',
    };
    expect(adminActionErrorMessage(error, 'fallback')).toBe(
      'Commit or discard the live draft before closing the Session (LIVE_DRAFT_NOT_EMPTY)',
    );
  });

  it('reloads stale or state-conflicting administrator views', () => {
    expect(shouldReloadAfterAdminActionError(
      { status: 409, code: 'VERSION_CONFLICT', message: 'Session changed' },
    )).toBe(true);
    expect(shouldReloadAfterAdminActionError(
      { status: 403, code: 'FORBIDDEN', message: 'Denied' },
    )).toBe(false);
  });

  it('dismisses and reloads a stale dangerous action only after a conflict', () => {
    expect(adminDangerActionRecovery(
      { status: 409, code: 'VERSION_CONFLICT', message: 'Session changed' },
    )).toBe('dismiss-and-reload');
    expect(adminDangerActionRecovery(
      { status: 403, code: 'FORBIDDEN', message: 'Denied' },
    )).toBe('keep-open');
  });

  it('falls back for non-error rejection values', () => {
    expect(adminActionErrorMessage(null, 'Request failed')).toBe('Request failed');
  });
});
