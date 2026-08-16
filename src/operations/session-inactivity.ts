import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { findSession, requireMembership } from '../collaboration/access';
import { getLiveDraftLockManager } from '../collaboration/live-draft';
import { getRealtimeHub } from '../collaboration/realtime';
import {
  liveDraftClearedFromEvent,
  mutateSession,
  type MutationOperation,
} from '../api/collaboration-sync-v1';

export const SESSION_INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
export const SESSION_INACTIVITY_SWEEP_INTERVAL_MS = 60 * 1_000;

interface ActivityRow {
  session_updated_at: string;
  latest_log_updated_at: string | null;
  latest_draft_updated_at: string | null;
  latest_event_at: string | null;
}

export interface InactivitySweepResult {
  readonly inspected: number;
  readonly closedSessionIds: readonly string[];
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function lastActivityAt(db: Database.Database, sessionId: string): number | null {
  const row = db.prepare(`
    SELECT
      s.updated_at AS session_updated_at,
      (SELECT MAX(l.updated_at) FROM logs l WHERE l.session_id = s.id)
        AS latest_log_updated_at,
      (SELECT d.last_updated_at FROM session_live_drafts d WHERE d.session_id = s.id)
        AS latest_draft_updated_at,
      (SELECT MAX(e.occurred_at) FROM session_events e WHERE e.session_id = s.id)
        AS latest_event_at
    FROM sessions s
    WHERE s.id = ? AND s.status = 'active' AND s.deleted_at IS NULL
  `).get(sessionId) as ActivityRow | undefined;
  if (!row) return null;
  const values = [
    row.session_updated_at,
    row.latest_log_updated_at,
    row.latest_draft_updated_at,
    row.latest_event_at,
  ].map(timestamp).filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * Closes every active collaboration Session whose last persisted mutation is
 * strictly older than two hours. A final activity check and the close happen
 * in the same synchronous SQLite transaction, so a record/draft write cannot
 * race between inspection and closure.
 */
export function sweepInactiveSessions(
  db: Database.Database,
  options: {
    now?: Date;
    timeoutMs?: number;
    onError?: (sessionId: string, error: unknown) => void;
  } = {},
): InactivitySweepResult {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? SESSION_INACTIVITY_TIMEOUT_MS;
  if (!Number.isFinite(now.getTime())) throw new Error('SESSION_INACTIVITY_NOW_INVALID');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('SESSION_INACTIVITY_TIMEOUT_INVALID');
  }
  const cutoffMs = now.getTime() - timeoutMs;
  const candidateIds = db.prepare(`
    SELECT id
    FROM sessions
    WHERE status = 'active' AND deleted_at IS NULL
    ORDER BY updated_at ASC, id ASC
  `).pluck().all() as string[];
  const closedSessionIds: string[] = [];

  for (const sessionId of candidateIds) {
    try {
      const committed = db.transaction(() => {
        const session = findSession(db, sessionId);
        if (!session || session.status !== 'active' || session.deleted_at) return undefined;
        const activityAt = lastActivityAt(db, sessionId);
        // "超过两小时" is strict: a Session exactly on the cutoff remains
        // active until the next sweep.
        if (activityAt === null || activityAt >= cutoffMs) return undefined;
        const { membership } = requireMembership(
          db,
          sessionId,
          session.owner_user_id,
          ['owner'],
        );
        const mutationId = randomUUID();
        const operation: MutationOperation = {
          raw: {},
          mutationId,
          entityType: 'session',
          entityId: sessionId,
          operation: 'close',
          baseVersion: Number(session.version),
        };
        const outcome = mutateSession(
          db,
          session,
          membership,
          operation,
          session.owner_user_id,
          randomUUID(),
          `inactivity-${mutationId}`,
          {
            administrative: true,
            discardLiveDraftOnClose: true,
            now,
          },
        );
        return outcome.event;
      }).immediate();
      if (!committed) continue;

      closedSessionIds.push(sessionId);
      const hub = getRealtimeHub(db);
      hub.publish(committed);
      getLiveDraftLockManager(db).clearSession(sessionId);
      const cleared = liveDraftClearedFromEvent(committed);
      if (cleared) {
        hub.publishControl({
          type: 'liveDraft.cleared',
          sessionId,
          occurredAt: committed.occurredAt,
          discardedBy: {
            userId: committed.actor.userId,
            username: committed.actor.displayName,
          },
          discardedDraftId: cleared.discardedDraftId,
          discardedDraftVersion: cleared.discardedDraftVersion,
          nextDraft: cleared.nextDraft,
          terminal: true,
          reason: 'inactivity',
        });
      } else {
        hub.publishControl({
          type: 'liveDraft.lockChanged',
          sessionId,
          occurredAt: committed.occurredAt,
          action: 'sessionClosed',
          locks: [],
          reason: 'inactivity',
        });
      }
    } catch (error) {
      options.onError?.(sessionId, error);
    }
  }

  return { inspected: candidateIds.length, closedSessionIds };
}

export function startSessionInactivityMonitor(
  db: Database.Database,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    onError?: (sessionId: string, error: unknown) => void;
  } = {},
): { stop(): void; runNow(): InactivitySweepResult } {
  const intervalMs = options.intervalMs ?? SESSION_INACTIVITY_SWEEP_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('SESSION_INACTIVITY_INTERVAL_INVALID');
  }
  const runNow = () => sweepInactiveSessions(db, {
    timeoutMs: options.timeoutMs,
    onError: options.onError,
  });
  runNow();
  const timer = setInterval(runNow, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    runNow,
  };
}
