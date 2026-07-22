import Database from 'better-sqlite3';
import { RequestHandler, Router } from 'express';
import { AppConfig } from '../config';
import { normalizeStableId } from '../collaboration/access';
import { getRealtimeHub } from '../collaboration/realtime';
import { publicShareFeatureAvailable } from '../collaboration/public';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import { getRuntimeMetrics } from '../operations/metrics';
import {
  getPublicShareAnalytics,
  listPublicShareAnalytics,
  listPublicShareVisitorSessions,
  PUBLIC_SHARE_VIEW_SESSION_LIMITS,
  PublicShareAnalytics,
  readPublicShareAnalyticsSummary,
} from '../operations/public-share-analytics';
import { rejectUnknownKeys } from '../utils/validation';

export interface CollaborationMetricsV1Dependencies {
  db: Database.Database;
  config: AppConfig;
}

interface MetricsGaugeRow {
  instance_id: string;
  session_total: number;
  session_initializing: number;
  session_active: number;
  session_closed: number;
  session_deleted: number;
  log_live: number;
  log_tombstone: number;
  membership_active: number;
  membership_removed: number;
  active_invites: number;
  active_public_shares: number;
  member_ws_tickets: number;
  public_ws_tickets: number;
  session_events: number;
  processed_mutations: number;
  sessions_with_pruned_history: number;
  pruned_through_seq_total: number;
  retained_event_span_total: number;
  live_drafts: number;
  live_draft_device_states: number;
}

const PUBLIC_LIVESHARE_VISITOR_LIMIT = 200;

interface PublicLiveshareVisitorDto {
  ipAddress: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  currentConnections: number;
}

function currentAdminMiddleware(db: Database.Database): RequestHandler {
  return (req: V1AuthRequest, _res, next) => {
    try {
      const current = db.prepare('SELECT role FROM users WHERE id = ?').get(
        req.auth!.userId,
      ) as { role: string } | undefined;
      if (!current) {
        throw new AppError(401, 'TOKEN_INVALID', 'Access token user no longer exists');
      }
      if (req.auth!.role !== 'admin' || current.role !== 'admin') {
        throw new AppError(
          403,
          'ADMIN_REQUIRED',
          'Server administrator privileges are required',
        );
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

function analyticsLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'limit must be a positive integer', {
      field: 'limit',
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 100) {
    throw new AppError(422, 'VALIDATION_FAILED', 'limit must be between 1 and 100', {
      field: 'limit',
      min: 1,
      max: 100,
    });
  }
  return parsed;
}

function publicLiveshareScope(db: Database.Database) {
  const migration = db.prepare(`
    SELECT applied_at
    FROM schema_migrations
    WHERE version = 23 AND name = 'public_share_analytics'
  `).get() as { applied_at: string } | undefined;
  return {
    currentConnections: 'current-process' as const,
    openCounts: 'current-database' as const,
    singleProcessOnly: true,
    anonymousPageSessions: true,
    trackingStartedAt: migration?.applied_at ?? null,
    viewSessionDetailLimits: PUBLIC_SHARE_VIEW_SESSION_LIMITS,
    visitorDetailLimit: PUBLIC_LIVESHARE_VISITOR_LIMIT,
    visitorIpSource: 'trusted-request-ip' as const,
  };
}

function publicLiveshareVisitors(
  db: Database.Database,
  publicShareId: string,
) {
  const stored = listPublicShareVisitorSessions(
    db,
    publicShareId,
    PUBLIC_LIVESHARE_VISITOR_LIMIT,
  );
  const storedByHash = new Map(stored.map((item) => [item.viewSessionHash, item]));
  const activeGroups = new Map<string, {
    viewSessionHash?: string;
    ipAddress: string;
    currentConnections: number;
  }>();
  for (const connection of getRealtimeHub(db).publicShareConnections(publicShareId)) {
    const key = `${connection.viewSessionHash ?? 'untracked'}\0${connection.ipAddress}`;
    const current = activeGroups.get(key);
    if (current) current.currentConnections += 1;
    else activeGroups.set(key, { ...connection, currentConnections: 1 });
  }

  const activeHashes = new Set<string>();
  const visitors: PublicLiveshareVisitorDto[] = [...activeGroups.values()].map((active) => {
    const historical = active.viewSessionHash
      ? storedByHash.get(active.viewSessionHash)
      : undefined;
    if (active.viewSessionHash) activeHashes.add(active.viewSessionHash);
    return {
      ipAddress: active.ipAddress,
      firstSeenAt: historical?.firstSeenAt ?? null,
      lastSeenAt: historical?.lastSeenAt ?? null,
      currentConnections: active.currentConnections,
    };
  });
  for (const historical of stored) {
    if (activeHashes.has(historical.viewSessionHash)) continue;
    visitors.push({
      ipAddress: historical.ipAddress,
      firstSeenAt: historical.firstSeenAt,
      lastSeenAt: historical.lastSeenAt,
      currentConnections: 0,
    });
  }
  return visitors
    .sort((left, right) =>
      right.currentConnections - left.currentConnections ||
      String(right.lastSeenAt ?? '').localeCompare(String(left.lastSeenAt ?? '')) ||
      String(left.ipAddress ?? '').localeCompare(String(right.ipAddress ?? '')),
    )
    .slice(0, PUBLIC_LIVESHARE_VISITOR_LIMIT);
}

function publicLiveshareItem(
  analytics: PublicShareAnalytics,
  connections: ReadonlyMap<string, number>,
) {
  return {
    publicShareId: analytics.publicShareId,
    sessionId: analytics.sessionId,
    sessionTitle: analytics.sessionTitle,
    sessionStatus: analytics.sessionStatus,
    state: analytics.status,
    createdAt: analytics.shareCreatedAt,
    expiresAt: analytics.shareExpiresAt,
    revokedAt: analytics.shareRevokedAt,
    currentConnections: connections.get(analytics.publicShareId) ?? 0,
    totalOpens: analytics.totalOpens,
    openCountSaturated: analytics.openCountSaturated,
    openCountSaturatedAt: analytics.openCountSaturatedAt,
    firstOpenedAt: analytics.firstOpenedAt,
    lastOpenedAt: analytics.lastOpenedAt,
    lastAccessedAt: analytics.lastAccessedAt,
  };
}

function readDatabaseGauges(db: Database.Database, now: string): MetricsGaugeRow {
  const row = db.prepare(`
    SELECT
      ss.instance_id,
      (SELECT COUNT(*) FROM sessions) AS session_total,
      (SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL AND status = 'initializing')
        AS session_initializing,
      (SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL AND status = 'active')
        AS session_active,
      (SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL AND status = 'closed')
        AS session_closed,
      (SELECT COUNT(*) FROM sessions WHERE deleted_at IS NOT NULL) AS session_deleted,
      (SELECT COUNT(*) FROM logs WHERE deleted_at IS NULL) AS log_live,
      (SELECT COUNT(*) FROM logs WHERE deleted_at IS NOT NULL) AS log_tombstone,
      (
        SELECT COUNT(*)
        FROM session_members sm
        JOIN sessions s ON s.id = sm.session_id
        WHERE sm.removed_at IS NULL AND s.deleted_at IS NULL
      ) AS membership_active,
      (SELECT COUNT(*) FROM session_members WHERE removed_at IS NOT NULL) AS membership_removed,
      (
        SELECT COUNT(*)
        FROM collaboration_invites i
        JOIN sessions s ON s.id = i.session_id
        WHERE i.revoked_at IS NULL
          AND i.expires_at > ?
          AND i.used_count < i.max_uses
          AND s.deleted_at IS NULL
      ) AS active_invites,
      (
        SELECT COUNT(*)
        FROM public_shares ps
        JOIN sessions s ON s.id = ps.session_id
        WHERE ps.revoked_at IS NULL
          AND ps.expires_at > ?
          AND s.deleted_at IS NULL
          AND s.status IN ('active', 'closed')
      ) AS active_public_shares,
      (
        SELECT COUNT(*)
        FROM ws_tickets t
        JOIN session_members sm
          ON sm.session_id = t.session_id AND sm.user_id = t.user_id
        JOIN sessions s ON s.id = t.session_id
        WHERE t.consumed_at IS NULL
          AND t.expires_at > ?
          AND sm.removed_at IS NULL
          AND t.issued_role = sm.role
          AND t.issued_membership_version = sm.version
          AND s.deleted_at IS NULL
          AND (s.status <> 'initializing' OR sm.role = 'owner')
      ) AS member_ws_tickets,
      (
        SELECT COUNT(*)
        FROM public_ws_tickets t
        JOIN public_shares ps ON ps.id = t.public_share_id
        JOIN sessions s ON s.id = ps.session_id
        WHERE t.consumed_at IS NULL
          AND t.expires_at > ?
          AND t.authorization_expires_at > ?
          AND ps.revoked_at IS NULL
          AND ps.expires_at > ?
          AND s.deleted_at IS NULL
          AND s.status IN ('active', 'closed')
      ) AS public_ws_tickets,
      (SELECT COUNT(*) FROM session_events) AS session_events,
      (SELECT COUNT(*) FROM processed_mutations) AS processed_mutations,
      (SELECT COUNT(*) FROM sessions WHERE min_retained_seq > 0)
        AS sessions_with_pruned_history,
      (SELECT COALESCE(SUM(min_retained_seq), 0) FROM sessions)
        AS pruned_through_seq_total,
      (SELECT COALESCE(SUM(event_seq - min_retained_seq), 0) FROM sessions)
        AS retained_event_span_total,
      (SELECT COUNT(*) FROM session_live_drafts) AS live_drafts,
      (SELECT COUNT(*) FROM live_draft_device_state) AS live_draft_device_states
    FROM server_settings ss
    WHERE ss.id = 1
  `).get(now, now, now, now, now, now) as MetricsGaugeRow | undefined;
  if (!row?.instance_id) {
    throw new AppError(500, 'SERVER_SETTINGS_MISSING', 'Server settings are not initialized');
  }
  return row;
}

export function createCollaborationMetricsV1Router(
  dependencies: CollaborationMetricsV1Dependencies,
): Router {
  const { db, config } = dependencies;
  const router = Router();
  const metrics = getRuntimeMetrics(db);
  const accessToken = createAccessTokenMiddleware(config, db);
  const currentAdmin = currentAdminMiddleware(db);
  const limiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyGenerator: (req) => {
      const auth = (req as V1AuthRequest).auth;
      return `${auth?.userId ?? 'anonymous'}:${req.ip}`;
    },
    message: 'Too many collaboration metrics requests',
  });

  router.get(
    '/collaboration-metrics',
    accessToken,
    currentAdmin,
    ...(config.rateLimitEnabled ? [limiter] : []),
    (req: V1AuthRequest, res, next) => {
      try {
        rejectUnknownKeys(req.query as Record<string, unknown>, []);
        const generatedAt = new Date().toISOString();
        const sample = db.transaction(() => ({
          gauges: readDatabaseGauges(db, generatedAt),
          publicLiveshareAvailable: publicShareFeatureAvailable(db, config),
        })).deferred();
        const { gauges } = sample;
        const runtime = metrics.snapshot();
        const activeMember = runtime.websockets.active.member;
        const activePublic = runtime.websockets.active.public;
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          schemaVersion: 2,
          serverInstanceId: gauges.instance_id,
          generatedAt,
          scope: {
            runtimeCounters: 'current-process',
            databaseGauges: 'current-database',
            countersStartedAt: runtime.startedAt,
            singleProcessOnly: true,
          },
          runtime: {
            process: runtime.process,
            system: runtime.system,
            http: runtime.requests,
            mutations: runtime.mutations,
            events: runtime.events,
            webSockets: runtime.websockets,
            liveDraft: runtime.liveDraft,
          },
          gauges: {
            runtime: {
              activeWebSockets: {
                total: activeMember + activePublic,
                member: activeMember,
                public: activePublic,
              },
            },
            database: {
              sessions: {
                total: Number(gauges.session_total),
                initializing: Number(gauges.session_initializing),
                active: Number(gauges.session_active),
                closed: Number(gauges.session_closed),
                deleted: Number(gauges.session_deleted),
              },
              logs: {
                live: Number(gauges.log_live),
                tombstone: Number(gauges.log_tombstone),
              },
              memberships: {
                active: Number(gauges.membership_active),
                removed: Number(gauges.membership_removed),
              },
              activeInvites: Number(gauges.active_invites),
              activePublicShares: Number(gauges.active_public_shares),
              authorizableWsTickets: {
                member: Number(gauges.member_ws_tickets),
                public: sample.publicLiveshareAvailable
                  ? Number(gauges.public_ws_tickets)
                  : 0,
              },
              storedRows: {
                sessionEvents: Number(gauges.session_events),
                processedMutations: Number(gauges.processed_mutations),
                liveDrafts: Number(gauges.live_drafts),
                liveDraftDeviceStates: Number(gauges.live_draft_device_states),
              },
              eventRetention: {
                sessionsWithPrunedHistory: Number(gauges.sessions_with_pruned_history),
                prunedThroughSeqTotal: Number(gauges.pruned_through_seq_total),
                retainedEventSpanTotal: Number(gauges.retained_event_span_total),
              },
            },
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/public-liveshare-stats',
    accessToken,
    currentAdmin,
    ...(config.rateLimitEnabled ? [limiter] : []),
    (req: V1AuthRequest, res, next) => {
      try {
        const query = req.query as Record<string, unknown>;
        rejectUnknownKeys(query, ['limit']);
        const limit = analyticsLimit(query.limit);
        const generatedAt = new Date().toISOString();
        const summary = readPublicShareAnalyticsSummary(db, generatedAt);
        const connections = getRealtimeHub(db).publicShareConnectionCounts();
        const currentConnections = [...connections.values()]
          .reduce((total, count) => total + count, 0);
        const connectedShares = [...connections.keys()]
          .map((publicShareId) => getPublicShareAnalytics(db, publicShareId, generatedAt))
          .filter((item) => item !== undefined);
        const recentShares = listPublicShareAnalytics(db, generatedAt, { limit });
        const uniqueShares = new Map(
          [...connectedShares, ...recentShares]
            .map((item) => [item.publicShareId, item]),
        );
        const items = [...uniqueShares.values()]
          .map((item) => publicLiveshareItem(item, connections))
          .sort((left, right) =>
            right.currentConnections - left.currentConnections ||
            Number(right.state === 'active') - Number(left.state === 'active') ||
            String(right.lastAccessedAt ?? right.createdAt)
              .localeCompare(String(left.lastAccessedAt ?? left.createdAt)),
          )
          .slice(0, limit);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          schemaVersion: 1,
          generatedAt,
          scope: publicLiveshareScope(db),
          totals: {
            activeShares: summary.shares.active,
            currentConnections,
            totalOpens: summary.totalOpens,
            sharesWithOpens: summary.shares.everOpened,
            saturatedShares: summary.shares.saturated,
          },
          items,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/public-liveshare-stats/:publicShareId',
    accessToken,
    currentAdmin,
    ...(config.rateLimitEnabled ? [limiter] : []),
    (req: V1AuthRequest, res, next) => {
      try {
        rejectUnknownKeys(req.query as Record<string, unknown>, []);
        const publicShareId = normalizeStableId(
          req.params.publicShareId,
          'publicShareId',
        );
        const generatedAt = new Date().toISOString();
        const analytics = getPublicShareAnalytics(db, publicShareId, generatedAt);
        if (!analytics) {
          throw new AppError(404, 'PUBLIC_SHARE_NOT_FOUND', 'Public share not found');
        }
        const connections = getRealtimeHub(db).publicShareConnectionCounts();
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          schemaVersion: 2,
          generatedAt,
          scope: publicLiveshareScope(db),
          item: publicLiveshareItem(analytics, connections),
          visitors: publicLiveshareVisitors(db, publicShareId),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
