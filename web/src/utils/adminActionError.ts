interface ApiErrorLike {
  status: number;
  code: string;
  message: string;
}

function isApiErrorLike(error: unknown): error is ApiErrorLike {
  if (!error || typeof error !== 'object') return false;
  const value = error as Partial<ApiErrorLike>;
  return typeof value.status === 'number' && typeof value.code === 'string' &&
    typeof value.message === 'string';
}

export function adminActionErrorMessage(error: unknown, fallback: string): string {
  if (isApiErrorLike(error)) return `${error.message} (${error.code})`;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

export function shouldReloadAfterAdminActionError(error: unknown): boolean {
  return isApiErrorLike(error) && error.status === 409;
}

export type AdminDangerActionRecovery = 'keep-open' | 'dismiss-and-reload';

export function adminDangerActionRecovery(error: unknown): AdminDangerActionRecovery {
  return shouldReloadAfterAdminActionError(error) ? 'dismiss-and-reload' : 'keep-open';
}
