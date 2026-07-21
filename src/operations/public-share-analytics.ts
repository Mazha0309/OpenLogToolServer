import { createHmac } from 'crypto';
import Database from 'better-sqlite3';
import { AppConfig } from '../config';

const VIEW_SESSION_HMAC_DOMAIN = 'openlogtool/public-share-view-session/v1';
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const CLEANUP_BATCH_SIZE = 5_000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1_000;
export const PUBLIC_SHARE_VIEW_SESSION_LIMITS: Readonly<PublicShareViewSessionLimits> =
  Object.freeze({
    perShare: 10_000,
    total: 100_000,
  });

export interface PublicShareViewSessionLimits {
  perShare: number;
  total: number;
}

export type PublicShareAnalyticsStatus =
  | 'active'
  | 'revoked'
  | 'expired'
  | 'sessionDeleted';

export interface PublicShareAnalytics {
  publicShareId: string;
  sessionId: string;
  sessionTitle: string;
  sessionStatus: string;
  shareCreatedAt: string;
  shareExpiresAt: string;
  shareRevokedAt: string | null;
  sessionDeletedAt: string | null;
  status: PublicShareAnalyticsStatus;
  active: boolean;
  revoked: boolean;
  expired: boolean;
  sessionDeleted: boolean;
  totalOpens: number;
  openCountSaturated: boolean;
  openCountSaturatedAt: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  lastAccessedAt: string | null;
}

export interface PublicShareAnalyticsSummary {
  shares: {
    total: number;
    active: number;
    revoked: number;
    expired: number;
    sessionDeleted: number;
    everOpened: number;
    saturated: number;
  };
  totalOpens: number;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  lastAccessedAt: string | null;
}

export interface PublicShareOpenResult {
  newOpen: boolean;
  openCountSaturated: boolean;
  openCountSaturatedAt: string | null;
  totalOpens: number;
  firstOpenedAt: string;
  lastOpenedAt: string;
  lastAccessedAt: string;
}

export interface PublicShareViewCleanupResult {
  attempted: boolean;
  deletedViewSessions: number;
  failed: boolean;
}

interface AnalyticsRow {
  public_share_id: string;
  session_id: string;
  session_title: string;
  session_status: string;
  share_created_at: string;
  share_expires_at: string;
  share_revoked_at: string | null;
  session_deleted_at: string | null;
  total_opens: number;
  first_opened_at: string | null;
  last_opened_at: string | null;
  last_accessed_at: string | null;
  count_saturated_at: string | null;
}

interface TotalsRow {
  total_opens: number;
  first_opened_at: string;
  last_opened_at: string;
  last_accessed_at: string;
  count_saturated_at: string | null;
}

interface SummaryRow {
  share_total: number;
  share_active: number;
  share_revoked: number;
  share_expired: number;
  share_session_deleted: number;
  share_ever_opened: number;
  share_saturated: number;
  total_opens: number;
  first_opened_at: string | null;
  last_opened_at: string | null;
  last_accessed_at: string | null;
}

const lastCleanupAttemptByDatabase = new WeakMap<Database.Database, number>();

function canonicalTimestamp(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  const milliseconds = parsed.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('Analytics timestamp is invalid');
  return new Date(milliseconds).toISOString();
}

function viewSessionHash(
  config: AppConfig,
  publicShareId: string,
  viewSessionId: string,
): string {
  if (Buffer.byteLength(config.publicShareHmacKey || '', 'utf8') < 32) {
    throw new Error('Public share analytics require a configured public share HMAC key');
  }
  return createHmac('sha256', config.publicShareHmacKey)
    .update(`${VIEW_SESSION_HMAC_DOMAIN}\0${publicShareId}\0${viewSessionId}`)
    .digest('hex');
}

function analyticsStatus(
  row: Pick<
    AnalyticsRow,
    'share_expires_at' | 'share_revoked_at' | 'session_deleted_at'
  >,
  now: string,
): {
  status: PublicShareAnalyticsStatus;
  active: boolean;
  revoked: boolean;
  expired: boolean;
  sessionDeleted: boolean;
} {
  const revoked = row.share_revoked_at !== null;
  const expired = row.share_expires_at <= now;
  const sessionDeleted = row.session_deleted_at !== null;
  const status: PublicShareAnalyticsStatus = sessionDeleted
    ? 'sessionDeleted'
    : revoked
      ? 'revoked'
      : expired
        ? 'expired'
        : 'active';
  return { status, active: status === 'active', revoked, expired, sessionDeleted };
}

function analyticsDto(row: AnalyticsRow, now: string): PublicShareAnalytics {
  return {
    publicShareId: row.public_share_id,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    sessionStatus: row.session_status,
    shareCreatedAt: row.share_created_at,
    shareExpiresAt: row.share_expires_at,
    shareRevokedAt: row.share_revoked_at,
    sessionDeletedAt: row.session_deleted_at,
    ...analyticsStatus(row, now),
    totalOpens: Number(row.total_opens),
    openCountSaturated: row.count_saturated_at !== null,
    openCountSaturatedAt: row.count_saturated_at,
    firstOpenedAt: row.first_opened_at,
    lastOpenedAt: row.last_opened_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

const ANALYTICS_SELECT = `
  SELECT
    ps.id AS public_share_id,
    ps.session_id,
    s.title AS session_title,
    s.status AS session_status,
    ps.created_at AS share_created_at,
    ps.expires_at AS share_expires_at,
    ps.revoked_at AS share_revoked_at,
    s.deleted_at AS session_deleted_at,
    COALESCE(t.total_opens, 0) AS total_opens,
    t.first_opened_at,
    t.last_opened_at,
    t.last_accessed_at,
    t.count_saturated_at
  FROM public_shares ps
  JOIN sessions s ON s.id = ps.session_id
  LEFT JOIN public_share_view_totals t ON t.public_share_id = ps.id
`;

function validatedViewSessionLimits(
  limits: Readonly<PublicShareViewSessionLimits>,
): Readonly<PublicShareViewSessionLimits> {
  if (
    !Number.isSafeInteger(limits.perShare) || limits.perShare < 1 ||
    !Number.isSafeInteger(limits.total) || limits.total < 1
  ) {
    throw new Error('Public share analytics limits must be positive safe integers');
  }
  return limits;
}

function readTotals(
  db: Database.Database,
  publicShareId: string,
): TotalsRow {
  const totals = db.prepare(`
    SELECT
      total_opens, first_opened_at, last_opened_at,
      last_accessed_at, count_saturated_at
    FROM public_share_view_totals
    WHERE public_share_id = ?
  `).get(publicShareId) as TotalsRow | undefined;
  if (!totals) throw new Error('Public share analytics totals are missing');
  return totals;
}

function openResult(totals: TotalsRow, newOpen: boolean): PublicShareOpenResult {
  return {
    newOpen,
    openCountSaturated: totals.count_saturated_at !== null,
    openCountSaturatedAt: totals.count_saturated_at,
    totalOpens: Number(totals.total_opens),
    firstOpenedAt: totals.first_opened_at,
    lastOpenedAt: totals.last_opened_at,
    lastAccessedAt: totals.last_accessed_at,
  };
}

export function recordPublicShareOpen(
  db: Database.Database,
  config: AppConfig,
  publicShareId: string,
  viewSessionId: string,
  now: string | Date,
  limits: Readonly<PublicShareViewSessionLimits> = PUBLIC_SHARE_VIEW_SESSION_LIMITS,
): PublicShareOpenResult {
  const occurredAt = canonicalTimestamp(now);
  const hash = viewSessionHash(config, publicShareId, viewSessionId);
  const capacity = validatedViewSessionLimits(limits);

  // Free detail rows belonging to shares that can no longer exchange before
  // applying the hard global bound. Cleanup failures are deliberately ignored.
  maybeCleanupPublicShareViewSessions(db, occurredAt);

  const result = db.transaction(() => {
    const existingTotals = db.prepare(`
      SELECT
        total_opens, first_opened_at, last_opened_at,
        last_accessed_at, count_saturated_at
      FROM public_share_view_totals
      WHERE public_share_id = ?
    `).get(publicShareId) as TotalsRow | undefined;

    if (existingTotals?.count_saturated_at) {
      db.prepare(`
        UPDATE public_share_view_sessions
        SET last_seen_at = CASE
          WHEN ? > last_seen_at THEN ? ELSE last_seen_at
        END
        WHERE public_share_id = ? AND view_session_hash = ?
      `).run(occurredAt, occurredAt, publicShareId, hash);
      db.prepare(`
        UPDATE public_share_view_totals
        SET last_accessed_at = CASE
          WHEN ? > last_accessed_at THEN ? ELSE last_accessed_at
        END
        WHERE public_share_id = ?
      `).run(occurredAt, occurredAt, publicShareId);
      return openResult(readTotals(db, publicShareId), false);
    }

    const knownView = db.prepare(`
      UPDATE public_share_view_sessions
      SET last_seen_at = CASE
        WHEN ? > last_seen_at THEN ? ELSE last_seen_at
      END
      WHERE public_share_id = ? AND view_session_hash = ?
    `).run(occurredAt, occurredAt, publicShareId, hash).changes === 1;
    if (knownView) {
      db.prepare(`
        UPDATE public_share_view_totals
        SET last_accessed_at = CASE
          WHEN ? > last_accessed_at THEN ? ELSE last_accessed_at
        END
        WHERE public_share_id = ?
      `).run(occurredAt, occurredAt, publicShareId);
      return openResult(readTotals(db, publicShareId), false);
    }

    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM public_share_view_sessions) AS total_count,
        (SELECT COUNT(*) FROM public_share_view_sessions WHERE public_share_id = ?)
          AS share_count
    `).get(publicShareId) as { total_count: number; share_count: number };
    const saturated = Number(counts.share_count) >= capacity.perShare ||
      Number(counts.total_count) >= capacity.total;

    if (!saturated) {
      db.prepare(`
        INSERT INTO public_share_view_sessions (
          public_share_id, view_session_hash, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?)
      `).run(publicShareId, hash, occurredAt, occurredAt);
    }

    // The first valid open that reaches the storage bound is still counted,
    // then the aggregate is permanently marked as a lower bound. Later
    // unknown IDs are ignored instead of creating unbounded rows or inflated
    // renewal counts.
    db.prepare(`
      INSERT INTO public_share_view_totals (
        public_share_id, total_opens, first_opened_at,
        last_opened_at, last_accessed_at, count_saturated_at
      ) VALUES (?, 1, ?, ?, ?, ?)
      ON CONFLICT(public_share_id) DO UPDATE SET
        total_opens = public_share_view_totals.total_opens + 1,
        first_opened_at = CASE
          WHEN excluded.first_opened_at < public_share_view_totals.first_opened_at
            THEN excluded.first_opened_at
          ELSE public_share_view_totals.first_opened_at
        END,
        last_opened_at = CASE
          WHEN excluded.last_opened_at > public_share_view_totals.last_opened_at
            THEN excluded.last_opened_at
          ELSE public_share_view_totals.last_opened_at
        END,
        last_accessed_at = CASE
          WHEN excluded.last_accessed_at > public_share_view_totals.last_accessed_at
            THEN excluded.last_accessed_at
          ELSE public_share_view_totals.last_accessed_at
        END,
        count_saturated_at = CASE
          WHEN public_share_view_totals.count_saturated_at IS NOT NULL
            THEN public_share_view_totals.count_saturated_at
          WHEN excluded.count_saturated_at IS NULL THEN NULL
          WHEN excluded.count_saturated_at > public_share_view_totals.last_opened_at
            THEN excluded.count_saturated_at
          ELSE public_share_view_totals.last_opened_at
        END
    `).run(
      publicShareId,
      occurredAt,
      occurredAt,
      occurredAt,
      saturated ? occurredAt : null,
    );
    return openResult(readTotals(db, publicShareId), true);
  }).immediate();

  return result;
}

/**
 * Removes only per-view deduplication rows. Aggregate totals intentionally
 * remain available after a share expires, is revoked, or its Session is deleted.
 * Cleanup is opportunistic, throttled per database connection, and never makes
 * a successful public-share request fail.
 */
export function maybeCleanupPublicShareViewSessions(
  db: Database.Database,
  now: string | Date,
): PublicShareViewCleanupResult {
  const occurredAt = canonicalTimestamp(now);
  const nowMs = Date.parse(occurredAt);
  const previousAttempt = lastCleanupAttemptByDatabase.get(db);
  if (previousAttempt !== undefined && nowMs - previousAttempt < CLEANUP_INTERVAL_MS) {
    return { attempted: false, deletedViewSessions: 0, failed: false };
  }
  lastCleanupAttemptByDatabase.set(db, nowMs);

  try {
    const deleted = db.prepare(`
      DELETE FROM public_share_view_sessions
      WHERE rowid IN (
        SELECT views.rowid
        FROM public_share_view_sessions views
        JOIN public_shares ps ON ps.id = views.public_share_id
        JOIN sessions s ON s.id = ps.session_id
        WHERE ps.revoked_at IS NOT NULL
          OR ps.expires_at <= ?
          OR s.deleted_at IS NOT NULL
        ORDER BY views.last_seen_at, views.public_share_id, views.view_session_hash
        LIMIT ?
      )
    `).run(occurredAt, CLEANUP_BATCH_SIZE);
    if (Number(deleted.changes) >= CLEANUP_BATCH_SIZE) {
      // A full batch likely means more stale rows remain. Permit the next
      // request to make bounded progress instead of waiting five minutes.
      lastCleanupAttemptByDatabase.delete(db);
    }
    return {
      attempted: true,
      deletedViewSessions: Number(deleted.changes),
      failed: false,
    };
  } catch {
    return { attempted: true, deletedViewSessions: 0, failed: true };
  }
}

export function getPublicShareAnalytics(
  db: Database.Database,
  publicShareId: string,
  now: string | Date,
): PublicShareAnalytics | undefined {
  const occurredAt = canonicalTimestamp(now);
  maybeCleanupPublicShareViewSessions(db, occurredAt);
  const row = db.prepare(`${ANALYTICS_SELECT} WHERE ps.id = ?`).get(
    publicShareId,
  ) as AnalyticsRow | undefined;
  return row ? analyticsDto(row, occurredAt) : undefined;
}

export function listPublicShareAnalytics(
  db: Database.Database,
  now: string | Date,
  options: { sessionId?: string; limit?: number } = {},
): PublicShareAnalytics[] {
  const occurredAt = canonicalTimestamp(now);
  maybeCleanupPublicShareViewSessions(db, occurredAt);
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`Public share analytics limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  const rows = options.sessionId === undefined
    ? db.prepare(`
        ${ANALYTICS_SELECT}
        ORDER BY COALESCE(t.last_accessed_at, ps.created_at) DESC, ps.id DESC
        LIMIT ?
      `).all(limit) as AnalyticsRow[]
    : db.prepare(`
        ${ANALYTICS_SELECT}
        WHERE ps.session_id = ?
        ORDER BY COALESCE(t.last_accessed_at, ps.created_at) DESC, ps.id DESC
        LIMIT ?
      `).all(options.sessionId, limit) as AnalyticsRow[];
  return rows.map((row) => analyticsDto(row, occurredAt));
}

export function readPublicShareAnalyticsSummary(
  db: Database.Database,
  now: string | Date,
): PublicShareAnalyticsSummary {
  const occurredAt = canonicalTimestamp(now);
  maybeCleanupPublicShareViewSessions(db, occurredAt);
  const row = db.prepare(`
    SELECT
      COUNT(*) AS share_total,
      SUM(CASE
        WHEN s.deleted_at IS NULL AND ps.revoked_at IS NULL AND ps.expires_at > ?
          THEN 1 ELSE 0
      END) AS share_active,
      SUM(CASE
        WHEN s.deleted_at IS NULL AND ps.revoked_at IS NOT NULL
          THEN 1 ELSE 0
      END) AS share_revoked,
      SUM(CASE
        WHEN s.deleted_at IS NULL AND ps.revoked_at IS NULL AND ps.expires_at <= ?
          THEN 1 ELSE 0
      END) AS share_expired,
      SUM(CASE WHEN s.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS share_session_deleted,
      SUM(CASE WHEN t.public_share_id IS NOT NULL THEN 1 ELSE 0 END) AS share_ever_opened,
      SUM(CASE WHEN t.count_saturated_at IS NOT NULL THEN 1 ELSE 0 END)
        AS share_saturated,
      COALESCE(SUM(t.total_opens), 0) AS total_opens,
      MIN(t.first_opened_at) AS first_opened_at,
      MAX(t.last_opened_at) AS last_opened_at,
      MAX(t.last_accessed_at) AS last_accessed_at
    FROM public_shares ps
    JOIN sessions s ON s.id = ps.session_id
    LEFT JOIN public_share_view_totals t ON t.public_share_id = ps.id
  `).get(occurredAt, occurredAt) as SummaryRow;
  return {
    shares: {
      total: Number(row.share_total),
      active: Number(row.share_active),
      revoked: Number(row.share_revoked),
      expired: Number(row.share_expired),
      sessionDeleted: Number(row.share_session_deleted),
      everOpened: Number(row.share_ever_opened),
      saturated: Number(row.share_saturated),
    },
    totalOpens: Number(row.total_opens),
    firstOpenedAt: row.first_opened_at,
    lastOpenedAt: row.last_opened_at,
    lastAccessedAt: row.last_accessed_at,
  };
}
