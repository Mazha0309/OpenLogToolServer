export const LIVE_SHARE_EXPIRY_PRESETS = [1, 6, 12, 24, 72, 168, 720] as const;

export const DEFAULT_LIVE_SHARE_EXPIRY_HOURS = 24;
export const MIN_LIVE_SHARE_EXPIRY_HOURS = 1;
export const MAX_LIVE_SHARE_EXPIRY_HOURS = 720;

export type LiveShareExpiryPreset = (typeof LIVE_SHARE_EXPIRY_PRESETS)[number];
export type LiveShareExpirySelection = LiveShareExpiryPreset | 'custom';

export function validLiveShareExpiryHours(value: number | null): number | null {
  if (
    value === null
    || !Number.isInteger(value)
    || value < MIN_LIVE_SHARE_EXPIRY_HOURS
    || value > MAX_LIVE_SHARE_EXPIRY_HOURS
  ) return null;
  return value;
}

export function resolveLiveShareExpiryHours(
  selection: LiveShareExpirySelection,
  customHours: number | null,
): number | null {
  return selection === 'custom'
    ? validLiveShareExpiryHours(customHours)
    : selection;
}

export function liveShareExpiresAt(hours: number, now = Date.now()): Date {
  return new Date(now + hours * 60 * 60 * 1000);
}
