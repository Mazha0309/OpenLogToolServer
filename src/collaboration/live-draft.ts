import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { AppError } from '../errors/app-error';

export const LIVE_DRAFT_FIELDS = [
  'time',
  'controller',
  'callsign',
  'rstSent',
  'rstRcvd',
  'qth',
  'device',
  'power',
  'antenna',
  'height',
  'remarks',
] as const;

export type LiveDraftField = (typeof LIVE_DRAFT_FIELDS)[number];

export const EMPTY_FIELD_REVISIONS: Readonly<Record<LiveDraftField, number>> =
  Object.freeze(Object.fromEntries(LIVE_DRAFT_FIELDS.map((field) => [field, 0])) as
    Record<LiveDraftField, number>);

export const LIVE_DRAFT_LEASE_MS = 30_000;

export function isLiveDraftField(value: unknown): value is LiveDraftField {
  return typeof value === 'string' && (LIVE_DRAFT_FIELDS as readonly string[]).includes(value);
}

export interface LiveDraftLock {
  leaseId: string;
  sessionId: string;
  field: LiveDraftField;
  userId: string;
  username: string;
  deviceId: string;
  expiresAt: string;
}

interface StoredLock extends LiveDraftLock {
  expiresAtMs: number;
}

export class LiveDraftLockManager {
  private readonly byField = new Map<string, StoredLock>();
  private readonly byLease = new Map<string, StoredLock>();

  private fieldKey(sessionId: string, field: LiveDraftField): string {
    return `${sessionId}\0${field}`;
  }

  private remove(lock: StoredLock): void {
    this.byField.delete(this.fieldKey(lock.sessionId, lock.field));
    this.byLease.delete(lock.leaseId);
  }

  private prune(now = Date.now()): void {
    for (const lock of this.byLease.values()) {
      if (lock.expiresAtMs <= now) this.remove(lock);
    }
  }

  private dto(lock: StoredLock): LiveDraftLock {
    return {
      leaseId: lock.leaseId,
      sessionId: lock.sessionId,
      field: lock.field,
      userId: lock.userId,
      username: lock.username,
      deviceId: lock.deviceId,
      expiresAt: lock.expiresAt,
    };
  }

  list(sessionId: string): LiveDraftLock[] {
    this.prune();
    return [...this.byLease.values()]
      .filter((lock) => lock.sessionId === sessionId)
      .sort((left, right) => left.field.localeCompare(right.field))
      .map((lock) => this.dto(lock));
  }

  acquire(input: {
    sessionId: string;
    field: LiveDraftField;
    userId: string;
    username: string;
    deviceId: string;
  }): { lock: LiveDraftLock; reused: boolean } {
    const now = Date.now();
    this.prune(now);
    const key = this.fieldKey(input.sessionId, input.field);
    const existing = this.byField.get(key);
    if (existing) {
      if (existing.userId !== input.userId || existing.deviceId !== input.deviceId) {
        throw new AppError(
          409,
          'LIVE_DRAFT_FIELD_LOCKED',
          'The live draft field is being edited by another member',
          {
            field: input.field,
            holder: {
              userId: existing.userId,
              username: existing.username,
              expiresAt: existing.expiresAt,
            },
          },
        );
      }
      existing.expiresAtMs = now + LIVE_DRAFT_LEASE_MS;
      existing.expiresAt = new Date(existing.expiresAtMs).toISOString();
      return { lock: this.dto(existing), reused: true };
    }

    const stored: StoredLock = {
      leaseId: randomUUID(),
      sessionId: input.sessionId,
      field: input.field,
      userId: input.userId,
      username: input.username,
      deviceId: input.deviceId,
      expiresAtMs: now + LIVE_DRAFT_LEASE_MS,
      expiresAt: new Date(now + LIVE_DRAFT_LEASE_MS).toISOString(),
    };
    this.byField.set(key, stored);
    this.byLease.set(stored.leaseId, stored);
    return { lock: this.dto(stored), reused: false };
  }

  renew(input: {
    sessionId: string;
    leaseId: string;
    userId: string;
    deviceId: string;
  }): LiveDraftLock {
    const now = Date.now();
    this.prune(now);
    const lock = this.byLease.get(input.leaseId);
    if (!lock || lock.sessionId !== input.sessionId) {
      throw new AppError(404, 'LIVE_DRAFT_LOCK_NOT_FOUND', 'Live draft field lock not found');
    }
    if (lock.userId !== input.userId || lock.deviceId !== input.deviceId) {
      throw new AppError(403, 'FORBIDDEN', 'The live draft field lock belongs to another device');
    }
    lock.expiresAtMs = now + LIVE_DRAFT_LEASE_MS;
    lock.expiresAt = new Date(lock.expiresAtMs).toISOString();
    return this.dto(lock);
  }

  release(input: {
    sessionId: string;
    leaseId: string;
    userId: string;
    deviceId: string;
  }): LiveDraftLock {
    this.prune();
    const lock = this.byLease.get(input.leaseId);
    if (!lock || lock.sessionId !== input.sessionId) {
      throw new AppError(404, 'LIVE_DRAFT_LOCK_NOT_FOUND', 'Live draft field lock not found');
    }
    if (lock.userId !== input.userId || lock.deviceId !== input.deviceId) {
      throw new AppError(403, 'FORBIDDEN', 'The live draft field lock belongs to another device');
    }
    this.remove(lock);
    return this.dto(lock);
  }

  consume(input: {
    sessionId: string;
    field: LiveDraftField;
    leaseId: string;
    userId: string;
    deviceId: string;
  }): LiveDraftLock | undefined {
    const lock = this.byLease.get(input.leaseId);
    if (
      !lock ||
      lock.sessionId !== input.sessionId ||
      lock.field !== input.field ||
      lock.userId !== input.userId ||
      lock.deviceId !== input.deviceId
    ) {
      return undefined;
    }
    this.remove(lock);
    return this.dto(lock);
  }

  assertLease(input: {
    sessionId: string;
    field: LiveDraftField;
    leaseId: string;
    userId: string;
    deviceId: string;
  }): void {
    this.prune();
    const lock = this.byLease.get(input.leaseId);
    if (
      !lock ||
      lock.sessionId !== input.sessionId ||
      lock.field !== input.field ||
      lock.userId !== input.userId ||
      lock.deviceId !== input.deviceId
    ) {
      throw new AppError(
        409,
        'LIVE_DRAFT_LOCK_REQUIRED',
        'A current field lock is required to update the live draft',
        { field: input.field },
      );
    }
  }

  clearUser(sessionId: string, userId: string): LiveDraftLock[] {
    this.prune();
    const removed = [...this.byLease.values()]
      .filter((lock) => lock.sessionId === sessionId && lock.userId === userId);
    for (const lock of removed) this.remove(lock);
    return removed.map((lock) => this.dto(lock));
  }

  clearFields(
    sessionId: string,
    fields: ReadonlySet<LiveDraftField>,
  ): LiveDraftLock[] {
    this.prune();
    const removed = [...this.byLease.values()]
      .filter((lock) => lock.sessionId === sessionId && fields.has(lock.field));
    for (const lock of removed) this.remove(lock);
    return removed.map((lock) => this.dto(lock));
  }

  clearSession(sessionId: string): LiveDraftLock[] {
    this.prune();
    const removed = [...this.byLease.values()]
      .filter((lock) => lock.sessionId === sessionId);
    for (const lock of removed) this.remove(lock);
    return removed.map((lock) => this.dto(lock));
  }
}

const managers = new WeakMap<Database.Database, LiveDraftLockManager>();

export function getLiveDraftLockManager(db: Database.Database): LiveDraftLockManager {
  let manager = managers.get(db);
  if (!manager) {
    manager = new LiveDraftLockManager();
    managers.set(db, manager);
  }
  return manager;
}

export function liveDraftHasActualContent(db: Database.Database, sessionId: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM session_live_drafts
    WHERE session_id = ? AND (
      callsign IS NOT NULL OR qth IS NOT NULL OR device IS NOT NULL OR power IS NOT NULL OR
      antenna IS NOT NULL OR height IS NOT NULL OR remarks IS NOT NULL OR
      (rst_sent IS NOT NULL AND rst_sent <> '59') OR
      (rst_rcvd IS NOT NULL AND rst_rcvd <> '59')
    )
  `).get(sessionId);
  return Boolean(row);
}
