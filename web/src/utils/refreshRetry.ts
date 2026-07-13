interface RefreshFailure {
  code: string;
  details?: unknown;
}

export function refreshRetryDelay(error: RefreshFailure): number | null {
  if (error.code !== 'REFRESH_TOKEN_ROTATED') return null;
  const details = error.details && typeof error.details === 'object'
    ? error.details as Record<string, unknown>
    : undefined;
  const suggested = details?.retryAfterMilliseconds;
  return typeof suggested === 'number' && Number.isFinite(suggested)
    ? Math.min(10_000, Math.max(0, Math.round(suggested)))
    : 100;
}
