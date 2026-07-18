import Database from 'better-sqlite3';

const registeredDatabases = new WeakSet<Database.Database>();

/** Preserve the user's casing while storing newly accepted names as NFC. */
export function normalizeUsernameDisplay(username: string): string {
  return username.normalize('NFC');
}

/** Stable, locale-independent account identity for equality and uniqueness. */
export function usernameIdentity(username: string): string {
  return normalizeUsernameDisplay(username).toLowerCase().normalize('NFC');
}

/** Register the deterministic SQLite function used by the expression index. */
export function registerUsernameIdentityFunction(db: Database.Database): void {
  if (registeredDatabases.has(db)) return;
  db.function(
    'username_identity',
    { deterministic: true },
    (value: unknown) => typeof value === 'string' ? usernameIdentity(value) : null,
  );
  registeredDatabases.add(db);
}
