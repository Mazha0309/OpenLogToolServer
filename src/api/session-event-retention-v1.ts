import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { RequestHandler, Router } from 'express';
import { requireAdminElevation } from '../admin/elevation';
import { appendGovernanceAudit } from '../admin/governance-audit';
import {
  computeRequestHash,
  readStoredResponse,
  requireIdempotencyKey,
  storeResponse,
} from '../collaboration/idempotency';
import { AppConfig } from '../config';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import { getRequestId } from '../middleware/request-id';
import { rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';

export interface SessionEventRetentionV1Dependencies {
  db: Database.Database;
  config: AppConfig;
}

interface RetentionPolicy {
  retentionDays: number;
  minimumEventsPerSession: number;
  maxSessions: number;
  maxEvents: number;
}

interface CandidateSessionRow {
  id: string;
  event_seq: number;
  min_retained_seq: number;
  first_event_seq: number | null;
}

interface RetentionPlanResult {
  scannedSessionCount: number;
  affectedSessionCount: number;
  eventCount: number;
  hasMore: boolean;
}

const DEFAULT_RETENTION_DAYS = 180;
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3_650;
const DEFAULT_MINIMUM_EVENTS_PER_SESSION = 10_000;
const MIN_EVENTS_PER_SESSION = 1_000;
const MAX_EVENTS_PER_SESSION = 1_000_000;
const DEFAULT_MAX_SESSIONS = 100;
const MAX_SESSIONS = 100;
const MAX_EVENTS_PER_RUN = 25_000;
const POLICY_KEYS = [
  'retentionDays',
  'minimumEventsPerSession',
  'maxSessions',
] as const;
const CANONICAL_TIMESTAMP_GLOB =
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T' +
  '[0-9][0-9]:[0-9][0-9]:[0-9][0-9].' +
  '[0-9][0-9][0-9]Z';

function canonicalTimestampSql(
  column: 'first_event.occurred_at' | 'retained_event.occurred_at',
): string {
  return `
    length(${column}) = 24 AND
    ${column} GLOB '${CANONICAL_TIMESTAMP_GLOB}' AND
    substr(${column}, 12, 2) BETWEEN '00' AND '23' AND
    substr(${column}, 15, 2) BETWEEN '00' AND '59' AND
    substr(${column}, 18, 2) BETWEEN '00' AND '59' AND
    COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}, 0)
  `;
}

const FIRST_EVENT_IS_CANONICAL_SQL = canonicalTimestampSql('first_event.occurred_at');
const RETAINED_EVENT_IS_CANONICAL_SQL = canonicalTimestampSql(
  'retained_event.occurred_at',
);

function validationError(message: string, details?: unknown): AppError {
  return new AppError(422, 'VALIDATION_FAILED', message, details);
}

function boundedInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
  source: 'query' | 'body',
): number {
  if (value === undefined) return fallback;
  const parsed = source === 'query'
    ? typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : Number.NaN
    : Number.isSafeInteger(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw validationError(`${field} must be an integer between ${minimum} and ${maximum}`, {
      field,
      min: minimum,
      max: maximum,
    });
  }
  return parsed;
}

function parsePolicy(
  input: Record<string, unknown>,
  source: 'query' | 'body',
): RetentionPolicy {
  rejectUnknownKeys(input, POLICY_KEYS);
  return {
    retentionDays: boundedInteger(
      input.retentionDays,
      'retentionDays',
      DEFAULT_RETENTION_DAYS,
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS,
      source,
    ),
    minimumEventsPerSession: boundedInteger(
      input.minimumEventsPerSession,
      'minimumEventsPerSession',
      DEFAULT_MINIMUM_EVENTS_PER_SESSION,
      MIN_EVENTS_PER_SESSION,
      MAX_EVENTS_PER_SESSION,
      source,
    ),
    maxSessions: boundedInteger(
      input.maxSessions,
      'maxSessions',
      DEFAULT_MAX_SESSIONS,
      1,
      MAX_SESSIONS,
      source,
    ),
    maxEvents: MAX_EVENTS_PER_RUN,
  };
}

function currentAdminMiddleware(db: Database.Database): RequestHandler {
  return (req: V1AuthRequest, _res, next) => {
    try {
      requireCurrentAdmin(db, req);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireCurrentAdmin(db: Database.Database, req: V1AuthRequest): void {
  const current = db.prepare('SELECT role FROM users WHERE id = ?').get(
    req.auth!.userId,
  ) as { role: string } | undefined;
  if (!current) {
    throw new AppError(401, 'TOKEN_INVALID', 'Access token user no longer exists');
  }
  if (req.auth!.role !== 'admin' || current.role !== 'admin') {
    throw new AppError(403, 'ADMIN_REQUIRED', 'Server administrator privileges are required');
  }
}

function retentionCutoff(evaluatedAt: string, retentionDays: number): string {
  return new Date(
    Date.parse(evaluatedAt) - retentionDays * 86_400_000,
  ).toISOString();
}

function integrityFailure(message: string): never {
  throw new AppError(
    500,
    'EVENT_RETENTION_INTEGRITY_FAILED',
    message,
  );
}

function executeRetentionPlan(
  db: Database.Database,
  policy: RetentionPolicy,
  cutoffOccurredBefore: string,
  apply: boolean,
): RetentionPlanResult {
  const candidates = db.prepare(`
    SELECT
      s.id,
      s.event_seq,
      s.min_retained_seq,
      first_event.seq AS first_event_seq
    FROM sessions s
    LEFT JOIN session_events first_event
      ON first_event.session_id = s.id
      AND first_event.seq = s.min_retained_seq + 1
    WHERE s.event_seq - s.min_retained_seq > ?
      AND (
        first_event.seq IS NULL OR (
          ${FIRST_EVENT_IS_CANONICAL_SQL} AND
          first_event.occurred_at < ?
        )
      )
    ORDER BY s.id
    LIMIT ?
  `).all(
    policy.minimumEventsPerSession,
    cutoffOccurredBefore,
    policy.maxSessions + 1,
  ) as CandidateSessionRow[];
  const hasCandidateOverflow = candidates.length > policy.maxSessions;
  const selected = hasCandidateOverflow ? candidates.slice(0, policy.maxSessions) : candidates;
  let remainingBudget = policy.maxEvents;
  let affectedSessionCount = 0;
  let eventCount = 0;
  let hasMore = hasCandidateOverflow;

  for (const session of selected) {
    if (remainingBudget === 0) {
      hasMore = true;
      break;
    }
    const oldMinimum = Number(session.min_retained_seq);
    const oldHead = Number(session.event_seq);
    if (session.first_event_seq === null) {
      integrityFailure('Session event history is missing its first retained event');
    }
    const countBound = oldHead - policy.minimumEventsPerSession;
    if (countBound <= oldMinimum) continue;
    const budgetBound = Math.min(countBound, oldMinimum + remainingBudget);

    const firstUnsafe = db.prepare(`
      SELECT seq
      FROM session_events retained_event
      WHERE retained_event.session_id = ?
        AND retained_event.seq > ?
        AND retained_event.seq <= ?
        AND NOT (
          ${RETAINED_EVENT_IS_CANONICAL_SQL} AND
          retained_event.occurred_at < ?
        )
      ORDER BY seq
      LIMIT 1
    `).get(
      session.id,
      oldMinimum,
      budgetBound,
      cutoffOccurredBefore,
    ) as { seq: number } | undefined;
    const target = firstUnsafe ? Number(firstUnsafe.seq) - 1 : budgetBound;
    if (target <= oldMinimum) continue;

    const expectedCount = target - oldMinimum;
    const actualCount = Number(db.prepare(`
      SELECT COUNT(*)
      FROM session_events
      WHERE session_id = ? AND seq > ? AND seq <= ?
    `).pluck().get(session.id, oldMinimum, target));
    if (actualCount !== expectedCount) {
      integrityFailure('Session event history is not a contiguous retained prefix');
    }

    if (apply) {
      const advanced = db.prepare(`
        UPDATE sessions
        SET min_retained_seq = ?
        WHERE id = ? AND min_retained_seq = ? AND event_seq = ?
      `).run(target, session.id, oldMinimum, oldHead);
      if (advanced.changes !== 1) {
        integrityFailure('Session event cursor changed during retention maintenance');
      }
      const deleted = db.prepare(`
        DELETE FROM session_events
        WHERE session_id = ? AND seq > ? AND seq <= ?
      `).run(session.id, oldMinimum, target);
      if (deleted.changes !== expectedCount) {
        integrityFailure('Session event deletion did not match the cursor advance');
      }
    }

    affectedSessionCount += 1;
    eventCount += expectedCount;
    remainingBudget -= expectedCount;
    if (!firstUnsafe && budgetBound < countBound) {
      const nextEvent = db.prepare(`
        SELECT
          seq,
          CASE WHEN
            ${RETAINED_EVENT_IS_CANONICAL_SQL} AND
            retained_event.occurred_at < ?
          THEN 1 ELSE 0 END AS provably_old
        FROM session_events retained_event
        WHERE retained_event.session_id = ? AND retained_event.seq = ?
      `).get(
        cutoffOccurredBefore,
        session.id,
        budgetBound + 1,
      ) as { seq: number; provably_old: number } | undefined;
      if (!nextEvent) {
        integrityFailure('Session event history is not contiguous after the retention budget');
      }
      if (Number(nextEvent.provably_old) === 1) hasMore = true;
    }
  }

  return {
    scannedSessionCount: selected.length,
    affectedSessionCount,
    eventCount,
    hasMore,
  };
}

function responseBody(
  operation: 'preview' | 'prune',
  evaluatedAt: string,
  cutoffOccurredBefore: string,
  policy: RetentionPolicy,
  result: RetentionPlanResult,
  auditEventId: string | null,
) {
  return {
    operation,
    evaluatedAt,
    cutoffOccurredBefore,
    policy,
    scannedSessionCount: result.scannedSessionCount,
    affectedSessionCount: result.affectedSessionCount,
    eventCount: result.eventCount,
    hasMore: result.hasMore,
    auditEventId,
  };
}

export function createSessionEventRetentionV1Router(
  dependencies: SessionEventRetentionV1Dependencies,
): Router {
  const { db, config } = dependencies;
  const router = Router();
  const accessToken = createAccessTokenMiddleware(config, db);
  const currentAdmin = currentAdminMiddleware(db);
  const previewLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 12,
    keyGenerator: (req) => `${(req as V1AuthRequest).auth?.userId ?? 'anonymous'}:${req.ip}`,
    message: 'Too many event retention preview requests',
  });
  const pruneLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 6,
    keyGenerator: (req) => `${(req as V1AuthRequest).auth?.userId ?? 'anonymous'}:${req.ip}`,
    message: 'Too many event retention prune requests',
  });

  router.get(
    '/session-event-retention/preview',
    accessToken,
    currentAdmin,
    ...(config.rateLimitEnabled ? [previewLimiter] : []),
    (req: V1AuthRequest, res, next) => {
      try {
        const policy = parsePolicy(req.query as Record<string, unknown>, 'query');
        const evaluatedAt = new Date().toISOString();
        const cutoffOccurredBefore = retentionCutoff(evaluatedAt, policy.retentionDays);
        const result = db.transaction(() => {
          requireCurrentAdmin(db, req);
          return executeRetentionPlan(db, policy, cutoffOccurredBefore, false);
        }).deferred();
        res.setHeader('Cache-Control', 'no-store');
        res.json(responseBody(
          'preview',
          evaluatedAt,
          cutoffOccurredBefore,
          policy,
          result,
          null,
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/session-event-retention/prune',
    accessToken,
    currentAdmin,
    ...(config.rateLimitEnabled ? [pruneLimiter] : []),
    (req: V1AuthRequest, res, next) => {
      try {
        rejectUnknownKeys(req.query as Record<string, unknown>, []);
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, [...POLICY_KEYS, 'reason']);
        const reason = requireString(body, 'reason', { min: 3, max: 500 });
        const policy = parsePolicy(
          Object.fromEntries(
            POLICY_KEYS.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]),
          ),
          'body',
        );
        const mutationId = requireIdempotencyKey(req);
        const requestHash = computeRequestHash(req.method, req.baseUrl + req.path, body);
        const evaluatedAt = new Date().toISOString();
        const cutoffOccurredBefore = retentionCutoff(evaluatedAt, policy.retentionDays);
        let replayed = false;
        const result = db.transaction(() => {
          requireCurrentAdmin(db, req);
          requireAdminElevation(db, config, req);
          const stored = readStoredResponse(
            db,
            mutationId,
            req.auth!.userId,
            requestHash,
          );
          if (stored) {
            replayed = true;
            return stored;
          }
          const plan = executeRetentionPlan(db, policy, cutoffOccurredBefore, true);
          let auditEventId: string | null = null;
          if (plan.eventCount > 0) {
            auditEventId = randomUUID();
            db.prepare(`
              INSERT INTO admin_audit_events (
                id, action, actor_user_id, target_user_id, request_id, mutation_id,
                before_json, after_json, details_json, occurred_at
              ) VALUES (?, 'session_events.pruned', ?, NULL, ?, ?, NULL, ?, ?, ?)
            `).run(
              auditEventId,
              req.auth!.userId,
              getRequestId(req),
              mutationId,
              JSON.stringify({
                eventCount: plan.eventCount,
                affectedSessionCount: plan.affectedSessionCount,
              }),
              JSON.stringify({
                evaluatedAt,
                cutoffOccurredBefore,
                retentionDays: policy.retentionDays,
                minimumEventsPerSession: policy.minimumEventsPerSession,
                maxSessions: policy.maxSessions,
                maxEvents: policy.maxEvents,
                scannedSessionCount: plan.scannedSessionCount,
                hasMore: plan.hasMore,
              }),
              evaluatedAt,
            );
          }
          appendGovernanceAudit(db, {
            action: 'session_events.pruned',
            actorUserId: req.auth!.userId,
            requestId: getRequestId(req),
            mutationId,
            targetType: 'server',
            targetId: 'primary',
            reason,
            details: {
              eventCount: plan.eventCount,
              affectedSessionCount: plan.affectedSessionCount,
              evaluatedAt,
              cutoffOccurredBefore,
              retentionDays: policy.retentionDays,
              minimumEventsPerSession: policy.minimumEventsPerSession,
              maxSessions: policy.maxSessions,
              maxEvents: policy.maxEvents,
              scannedSessionCount: plan.scannedSessionCount,
              hasMore: plan.hasMore,
            },
          });
          const response = responseBody(
            'prune',
            evaluatedAt,
            cutoffOccurredBefore,
            policy,
            plan,
            auditEventId,
          );
          storeResponse(db, {
            mutationId,
            userId: req.auth!.userId,
            requestHash,
            status: 200,
            body: response,
          });
          return { status: 200, body: response };
        }).immediate();
        if (replayed) res.setHeader('Idempotent-Replay', 'true');
        res.setHeader('Cache-Control', 'no-store');
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
