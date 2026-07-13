export type AuthMode = 'login' | 'register' | 'bootstrap';

export function isLegacyCompatibleLogin(mode: AuthMode, changingRequiredPassword: boolean): boolean {
  return mode === 'login' && !changingRequiredPassword;
}

export function submittedUsername(mode: AuthMode, value: string): string {
  return mode === 'login' ? value : value.trim();
}
