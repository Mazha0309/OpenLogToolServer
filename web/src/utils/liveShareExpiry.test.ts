import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_SHARE_EXPIRY_HOURS,
  LIVE_SHARE_EXPIRY_PRESETS,
  liveShareExpiresAt,
  resolveLiveShareExpiryHours,
  validLiveShareExpiryHours,
} from './liveShareExpiry';

describe('Live Share expiry', () => {
  it('keeps the API-supported presets and 24-hour default', () => {
    expect(LIVE_SHARE_EXPIRY_PRESETS).toEqual([1, 6, 12, 24, 72, 168, 720]);
    expect(DEFAULT_LIVE_SHARE_EXPIRY_HOURS).toBe(24);
  });

  it('accepts only whole custom hours in the 1 through 720 range', () => {
    expect(validLiveShareExpiryHours(1)).toBe(1);
    expect(validLiveShareExpiryHours(720)).toBe(720);
    expect(validLiveShareExpiryHours(0)).toBeNull();
    expect(validLiveShareExpiryHours(721)).toBeNull();
    expect(validLiveShareExpiryHours(1.5)).toBeNull();
    expect(resolveLiveShareExpiryHours('custom', 48)).toBe(48);
    expect(resolveLiveShareExpiryHours('custom', null)).toBeNull();
    expect(resolveLiveShareExpiryHours(72, null)).toBe(72);
  });

  it('calculates the estimated expiry from the selected hours', () => {
    expect(liveShareExpiresAt(24, Date.parse('2026-07-21T00:00:00.000Z')).toISOString())
      .toBe('2026-07-22T00:00:00.000Z');
  });
});
