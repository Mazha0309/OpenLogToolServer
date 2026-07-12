import { randomBytes, randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { RequestHandler, Router } from 'express';
import { AppConfig } from '../config';
import {
  findMembershipIncludingRemoved,
  findSession,
  normalizeStableId,
  SessionRow,
} from '../collaboration/access';
import { appendCollaborationAudit } from '../collaboration/audit';
import {
  computeRequestHash,
  readStoredResponse,
  requireIdempotencyKey,
  storeResponse,
} from '../collaboration/idempotency';
import {
  assertPublicShareConfig,
  derivePublicShareSecret,
  hashPublicShareSecret,
  hashPublicWsTicket,
  issuePublicAccessToken,
  PublicAccessIdentity,
  publicLogDto,
  PublicLogRow,
  publicSessionDto,
  publicShareDto,
  PublicShareRow,
  verifyPublicAccessToken,
} from '../collaboration/public';
import { getRealtimeHub } from '../collaboration/realtime';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import { getRequestId } from '../middleware/request-id';
import {
  rejectUnknownKeys,
  requireJsonObject,
  requireString,
} from '../utils/validation';

export interface PublicSharesV1Dependencies {
  db: Database.Database;
  config: AppConfig;
}

export interface PublicAccessRequest extends V1AuthRequest {
  publicAccess?: PublicAccessIdentity;
}

interface ActivePublicShareRow extends PublicShareRow {
  session_status: string;
  session_deleted_at: string | null;
  event_seq: number;
  min_retained_seq: number;
}

const DEFAULT_EXPIRES_IN_HOURS = 24;
const MAX_EXPIRES_IN_HOURS = 24 * 30;
const MAX_ACTIVE_SHARES_PER_SESSION = 20;
const MAX_PUBLIC_SNAPSHOT_LOGS = 20_000;
const MAX_PUBLIC_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_PUBLIC_SNAPSHOT_CONCURRENCY = 8;
const MAX_PUBLIC_SNAPSHOT_CONCURRENCY_PER_SHARE = 2;
const MAX_PUBLIC_WS_BACKLOG_EVENTS = 1_000;
const MAX_PENDING_PUBLIC_WS_TICKETS_PER_SHARE = 8;
const MAX_PENDING_PUBLIC_WS_TICKETS_PER_ACCESS_TOKEN = 4;
const MAX_PUBLIC_SHARE_HISTORY_PER_SESSION = 5_000;
const PUBLIC_SHARE_LIST_LIMIT = 50;

interface PublicShareCursor {
  createdAt: string;
  publicShareId: string;
}

function runImmediate<T>(db: Database.Database, operation: () => T): T {
  return db.transaction(operation).immediate();
}

function expiresInHours(body: Record<string, unknown>): number {
  const value = body.expiresInHours;
  if (value === undefined) return DEFAULT_EXPIRES_IN_HOURS;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > MAX_EXPIRES_IN_HOURS
  ) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      `expiresInHours must be an integer between 1 and ${MAX_EXPIRES_IN_HOURS}`,
      { field: 'expiresInHours', min: 1, max: MAX_EXPIRES_IN_HOURS },
    );
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a non-negative integer`, {
      field,
    });
  }
  return Number(value);
}

function queryInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be an integer`, { field });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      `${field} must be between ${minimum} and ${maximum}`,
      { field, min: minimum, max: maximum },
    );
  }
  return parsed;
}

function encodePublicShareCursor(row: PublicShareRow): string {
  return Buffer.from(JSON.stringify({
    createdAt: row.created_at,
    publicShareId: row.id,
  }), 'utf8').toString('base64url');
}

function decodePublicShareCursor(value: unknown): PublicShareCursor | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new AppError(422, 'VALIDATION_FAILED', 'after must be a valid cursor', {
      field: 'after',
    });
  }
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error();
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const cursor = parsed as Record<string, unknown>;
    if (
      Object.keys(cursor).sort().join(',') !== 'createdAt,publicShareId' ||
      typeof cursor.createdAt !== 'string' ||
      cursor.createdAt.length < 20 ||
      cursor.createdAt.length > 64 ||
      Number.isNaN(Date.parse(cursor.createdAt)) ||
      typeof cursor.publicShareId !== 'string'
    ) {
      throw new Error();
    }
    return {
      createdAt: cursor.createdAt,
      publicShareId: normalizeStableId(cursor.publicShareId, 'after'),
    };
  } catch {
    throw new AppError(422, 'VALIDATION_FAILED', 'after must be a valid cursor', {
      field: 'after',
    });
  }
}

function publicSnapshotLogStats(db: Database.Database, sessionId: string): {
  count: number;
  serializedBytes: number;
} {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(length(CAST(json_object(
        'syncId', sync_id,
        'time', time,
        'controller', controller,
        'callsign', callsign,
        'rstSent', rst_sent,
        'rstRcvd', rst_rcvd,
        'qth', qth,
        'device', device,
        'power', power,
        'antenna', antenna,
        'height', height,
        'remarks', remarks,
        'deletedAt', deleted_at
      ) AS BLOB))), 0) AS serialized_bytes
    FROM logs
    WHERE session_id = ? AND deleted_at IS NULL
  `).get(sessionId) as { count: number; serialized_bytes: number };
  return {
    count: Number(row.count),
    serializedBytes: Number(row.serialized_bytes),
  };
}

function requireCurrentOwner(
  db: Database.Database,
  sessionId: string,
  userId: string,
): SessionRow {
  const session = findSession(db, sessionId);
  const membership = findMembershipIncludingRemoved(db, sessionId, userId);
  if (!session || !membership) {
    throw new AppError(404, 'NOT_FOUND', 'Resource not found');
  }
  if (membership.removed_at) {
    throw new AppError(403, 'MEMBERSHIP_REVOKED', 'Session membership has been revoked', {
      removedAt: membership.removed_at,
    });
  }
  if (membership.role !== 'owner' || session.owner_user_id !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Only the current Session owner can manage public shares');
  }
  if (session.deleted_at) {
    throw new AppError(410, 'SESSION_DELETED', 'Session has been deleted', {
      deletedAt: session.deleted_at,
      finalSeq: session.event_seq,
    });
  }
  return session;
}

function activePublicShare(
  db: Database.Database,
  publicShareId: string,
  sessionId?: string,
): ActivePublicShareRow | undefined {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT
      ps.*,
      s.status AS session_status,
      s.deleted_at AS session_deleted_at,
      s.event_seq,
      s.min_retained_seq
    FROM public_shares ps
    JOIN sessions s ON s.id = ps.session_id
    WHERE ps.id = ?
      AND (? IS NULL OR ps.session_id = ?)
      AND ps.revoked_at IS NULL
      AND ps.expires_at > ?
      AND s.deleted_at IS NULL
      AND s.status IN ('active', 'closed')
  `).get(publicShareId, sessionId ?? null, sessionId ?? null, now) as
    | ActivePublicShareRow
    | undefined;
}

function invalidPublicShare(): never {
  throw new AppError(404, 'PUBLIC_SHARE_INVALID', 'Public share is invalid or unavailable');
}

function invalidPublicAccess(): never {
  throw new AppError(401, 'PUBLIC_ACCESS_INVALID', 'Public access token is invalid or expired');
}

function requirePublicScope(
  db: Database.Database,
  identity: PublicAccessIdentity,
  sessionId: string,
): ActivePublicShareRow {
  if (identity.sessionId !== sessionId) {
    throw new AppError(404, 'NOT_FOUND', 'Resource not found');
  }
  const share = activePublicShare(db, identity.publicShareId, sessionId);
  if (!share) invalidPublicAccess();
  return share;
}

export function createPublicAccessMiddleware(
  dependencies: PublicSharesV1Dependencies,
): RequestHandler {
  const { db, config } = dependencies;
  return (req: PublicAccessRequest, _res, next) => {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      next(new AppError(401, 'PUBLIC_ACCESS_INVALID', 'Public access token is invalid or expired'));
      return;
    }
    try {
      const identity = verifyPublicAccessToken(config, header.slice(7));
      assertPublicShareConfig(db, config);
      if (!activePublicShare(db, identity.publicShareId, identity.sessionId)) {
        invalidPublicAccess();
      }
      req.publicAccess = identity;
      next();
    } catch (error) {
      if (error instanceof AppError) next(error);
      else next(new AppError(401, 'PUBLIC_ACCESS_INVALID', 'Public access token is invalid or expired'));
    }
  };
}

function ownerMutationContext(req: V1AuthRequest) {
  const mutationId = requireIdempotencyKey(req);
  return {
    mutationId,
    userId: req.auth!.userId,
    requestId: getRequestId(req),
    requestHash: computeRequestHash(req.method, req.baseUrl + req.path, req.body),
  };
}

export function createSessionPublicSharesV1Router(
  dependencies: PublicSharesV1Dependencies,
): Router {
  const { db, config } = dependencies;
  const router = Router();
  const realtime = getRealtimeHub(db);
  router.use(createAccessTokenMiddleware(config));
  const actorManagementLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 60,
    keyGenerator: (req) => {
      const auth = (req as V1AuthRequest).auth;
      return `${auth?.userId ?? 'anonymous'}:${req.ip}:${req.params.sessionId ?? ''}`;
    },
    message: 'Too many public share management requests',
  });
  const accountSessionManagementLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 120,
    keyGenerator: (req) => {
      const auth = (req as V1AuthRequest).auth;
      return `${auth?.userId ?? 'anonymous'}:${req.params.sessionId ?? 'unknown'}`;
    },
    message: 'Too many public share management requests',
  });
  const managementLimiters: RequestHandler[] = config.rateLimitEnabled
    ? [actorManagementLimiter, accountSessionManagementLimiter]
    : [];

  router.post('/:sessionId/public-shares', ...managementLimiters, (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['expiresInHours']);
      const lifetimeHours = expiresInHours(body);
      const context = ownerMutationContext(req);
      let replayed = false;

      const result = runImmediate(db, () => {
        const session = requireCurrentOwner(db, sessionId, context.userId);
        assertPublicShareConfig(db, config);
        const stored = readStoredResponse(
          db,
          context.mutationId,
          context.userId,
          context.requestHash,
        );
        if (stored) {
          replayed = true;
          return stored;
        }
        if (session.status === 'initializing') {
          throw new AppError(
            409,
            'SESSION_NOT_ACTIVE',
            'An initializing Session cannot be shared publicly',
          );
        }
        if (!['active', 'closed'].includes(session.status)) {
          throw new AppError(409, 'INVALID_SESSION_STATE', 'Session cannot be shared publicly');
        }
        const now = new Date();
        const nowIso = now.toISOString();
        const activeCount = Number(db.prepare(`
          SELECT COUNT(*) FROM public_shares
          WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ?
        `).pluck().get(sessionId, nowIso));
        if (activeCount >= MAX_ACTIVE_SHARES_PER_SESSION) {
          throw new AppError(
            409,
            'PUBLIC_SHARE_LIMIT_REACHED',
            'The Session has reached its active public share limit',
          );
        }
        const historyCount = Number(db.prepare(`
          SELECT COUNT(*) FROM public_shares WHERE session_id = ?
        `).pluck().get(sessionId));
        if (historyCount >= MAX_PUBLIC_SHARE_HISTORY_PER_SESSION) {
          throw new AppError(
            409,
            'PUBLIC_SHARE_HISTORY_LIMIT_REACHED',
            'The Session has reached its retained public share history limit',
            { maximumShares: MAX_PUBLIC_SHARE_HISTORY_PER_SESSION },
          );
        }
        const publicShareId = randomUUID();
        const secret = derivePublicShareSecret(config, publicShareId);
        const expiresAt = new Date(
          now.getTime() + lifetimeHours * 3_600_000,
        ).toISOString();
        db.prepare(`
          INSERT INTO public_shares (
            id, session_id, credential_version, secret_hash,
            expires_at, created_by, created_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?)
        `).run(
          publicShareId,
          sessionId,
          hashPublicShareSecret(config, secret),
          expiresAt,
          context.userId,
          nowIso,
        );
        const share = db.prepare('SELECT * FROM public_shares WHERE id = ?').get(
          publicShareId,
        ) as PublicShareRow;
        const storedBody = { publicShare: publicShareDto(share) };
        appendCollaborationAudit(db, {
          action: 'public_share.created',
          sessionId,
          actorUserId: context.userId,
          requestId: context.requestId,
          mutationId: context.mutationId,
          occurredAt: nowIso,
          publicShareId,
          expiresAt,
        });
        storeResponse(db, {
          ...context,
          sessionId,
          status: 201,
          body: storedBody,
        });
        return { status: 201, body: storedBody };
      });

      const storedDto = (result.body as { publicShare: { publicShareId: string } }).publicShare;
      const share = activePublicShare(db, storedDto.publicShareId, sessionId);
      if (!share) {
        throw new AppError(409, 'PUBLIC_SHARE_NOT_ACTIVE', 'Public share is no longer active');
      }
      if (replayed) res.setHeader('Idempotent-Replay', 'true');
      res.status(result.status).json({
        publicShare: {
          ...publicShareDto(share),
          secret: derivePublicShareSecret(config, share.id),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:sessionId/public-shares', ...managementLimiters, (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      rejectUnknownKeys(req.query as Record<string, unknown>, ['limit', 'after']);
      const limit = queryInteger(
        req.query.limit,
        'limit',
        PUBLIC_SHARE_LIST_LIMIT,
        1,
        PUBLIC_SHARE_LIST_LIMIT,
      );
      const cursor = decodePublicShareCursor(req.query.after);
      const response = db.transaction(() => {
        requireCurrentOwner(db, sessionId, req.auth!.userId);
        const rows = db.prepare(`
          SELECT * FROM public_shares
          WHERE session_id = ?
            AND (
              ? IS NULL OR
              created_at < ? OR
              (created_at = ? AND id < ?)
            )
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(
          sessionId,
          cursor?.createdAt ?? null,
          cursor?.createdAt ?? null,
          cursor?.createdAt ?? null,
          cursor?.publicShareId ?? null,
          limit + 1,
        ) as PublicShareRow[];
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        return {
          publicShares: page.map(publicShareDto),
          nextCursor: hasMore && page.length > 0
            ? encodePublicShareCursor(page[page.length - 1])
            : null,
        };
      }).deferred();
      res.setHeader('Cache-Control', 'no-store');
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.delete(
    '/:sessionId/public-shares/:publicShareId',
    ...managementLimiters,
    (req: V1AuthRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const publicShareId = normalizeStableId(req.params.publicShareId, 'publicShareId');
        const context = ownerMutationContext(req);
        let replayed = false;
        const result = runImmediate(db, () => {
          requireCurrentOwner(db, sessionId, context.userId);
          const stored = readStoredResponse(
            db,
            context.mutationId,
            context.userId,
            context.requestHash,
          );
          if (stored) {
            replayed = true;
            return stored;
          }
          const share = db.prepare(`
            SELECT * FROM public_shares WHERE id = ? AND session_id = ?
          `).get(publicShareId, sessionId) as PublicShareRow | undefined;
          if (!share) throw new AppError(404, 'NOT_FOUND', 'Resource not found');
          const now = new Date().toISOString();
          let revokedWsTicketCount = 0;
          if (!share.revoked_at) {
            revokedWsTicketCount = db.prepare(`
              DELETE FROM public_ws_tickets WHERE public_share_id = ?
            `).run(publicShareId).changes;
            db.prepare(`
              UPDATE public_shares
              SET revoked_at = ?, revoked_by = ?
              WHERE id = ? AND revoked_at IS NULL
            `).run(now, context.userId, publicShareId);
            appendCollaborationAudit(db, {
              action: 'public_share.revoked',
              sessionId,
              actorUserId: context.userId,
              requestId: context.requestId,
              mutationId: context.mutationId,
              occurredAt: now,
              publicShareId,
              expiresAt: share.expires_at,
              revokedAt: now,
              revokedWsTicketCount,
            });
          }
          const updated = db.prepare('SELECT * FROM public_shares WHERE id = ?').get(
            publicShareId,
          ) as PublicShareRow;
          const response = { publicShare: publicShareDto(updated) };
          storeResponse(db, {
            ...context,
            sessionId,
            status: 200,
            body: response,
          });
          return { status: 200, body: response, revoked: share.revoked_at === null };
        });
        if ('revoked' in result && result.revoked) {
          realtime.revokePublicShare(publicShareId);
        }
        if (replayed) res.setHeader('Idempotent-Replay', 'true');
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export function createPublicShareExchangeV1Router(
  dependencies: PublicSharesV1Dependencies,
): Router {
  const { db, config } = dependencies;
  const router = Router();
  const ipLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 30,
    message: 'Too many public share exchange attempts',
  });
  const scopedLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 10,
    keyGenerator: (req) => `${req.ip}:${req.params.publicShareId ?? ''}`,
    message: 'Too many public share exchange attempts',
  });

  router.post(
    '/:publicShareId/exchange',
    ...(config.rateLimitEnabled ? [ipLimiter, scopedLimiter] : []),
    (req, res, next) => {
      try {
        const publicShareId = normalizeStableId(req.params.publicShareId, 'publicShareId');
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['secret']);
        const secret = requireString(body, 'secret', { min: 32, max: 128, trim: false });
        assertPublicShareConfig(db, config);
        const result = db.transaction(() => {
          const hash = hashPublicShareSecret(config, secret);
          const share = db.prepare(`
            SELECT
              ps.*,
              s.status AS session_status,
              s.deleted_at AS session_deleted_at,
              s.event_seq,
              s.min_retained_seq
            FROM public_shares ps
            JOIN sessions s ON s.id = ps.session_id
            WHERE ps.id = ? AND ps.secret_hash = ?
              AND ps.revoked_at IS NULL
              AND ps.expires_at > ?
              AND s.deleted_at IS NULL
              AND s.status IN ('active', 'closed')
          `).get(publicShareId, hash, new Date().toISOString()) as
            | ActivePublicShareRow
            | undefined;
          if (!share) invalidPublicShare();
          const token = issuePublicAccessToken(config, {
            publicShareId: share.id,
            sessionId: share.session_id,
            shareExpiresAt: share.expires_at,
          });
          return {
            ...token,
            tokenType: 'Bearer',
            publicShare: {
              publicShareId: share.id,
              sessionId: share.session_id,
              expiresAt: share.expires_at,
            },
          };
        }).deferred();
        res.setHeader('Cache-Control', 'no-store');
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}

export function createPublicSessionsV1Router(
  dependencies: PublicSharesV1Dependencies,
): Router {
  const { db, config } = dependencies;
  const router = Router();
  const publicAuth = createPublicAccessMiddleware(dependencies);
  const snapshotIpLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyGenerator: (req) => `${req.ip}:${req.params.sessionId ?? ''}`,
    message: 'Too many public snapshot requests',
  });
  const snapshotShareLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 60,
    keyGenerator: (req) =>
      (req as PublicAccessRequest).publicAccess?.publicShareId ?? 'anonymous',
    message: 'Too many public snapshot requests for this share',
  });
  const ticketIpLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyGenerator: (req) => `${req.ip}:${req.params.sessionId ?? ''}`,
    message: 'Too many public WebSocket ticket requests',
  });
  const ticketShareLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 60,
    keyGenerator: (req) =>
      (req as PublicAccessRequest).publicAccess?.publicShareId ?? 'anonymous',
    message: 'Too many public WebSocket ticket requests for this share',
  });
  let inFlightSnapshots = 0;
  const inFlightSnapshotsByShare = new Map<string, number>();
  const snapshotConcurrencyLimiter: RequestHandler = (req, res, next) => {
    const publicShareId = (req as PublicAccessRequest).publicAccess?.publicShareId;
    if (!publicShareId) {
      next(new AppError(401, 'PUBLIC_ACCESS_INVALID', 'Public access token is invalid or expired'));
      return;
    }
    const shareCount = inFlightSnapshotsByShare.get(publicShareId) ?? 0;
    if (
      inFlightSnapshots >= MAX_PUBLIC_SNAPSHOT_CONCURRENCY ||
      shareCount >= MAX_PUBLIC_SNAPSHOT_CONCURRENCY_PER_SHARE
    ) {
      res.setHeader('Retry-After', '1');
      next(new AppError(
        429,
        'PUBLIC_SNAPSHOT_BUSY',
        'Public snapshot capacity is temporarily busy',
        { retryAfterSeconds: 1 },
      ));
      return;
    }
    inFlightSnapshots += 1;
    inFlightSnapshotsByShare.set(publicShareId, shareCount + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlightSnapshots = Math.max(0, inFlightSnapshots - 1);
      const remaining = (inFlightSnapshotsByShare.get(publicShareId) ?? 1) - 1;
      if (remaining <= 0) inFlightSnapshotsByShare.delete(publicShareId);
      else inFlightSnapshotsByShare.set(publicShareId, remaining);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };

  router.get(
    '/:sessionId/snapshot',
    ...(config.rateLimitEnabled ? [snapshotIpLimiter] : []),
    publicAuth,
    ...(config.rateLimitEnabled ? [snapshotShareLimiter] : []),
    snapshotConcurrencyLimiter,
    (req: PublicAccessRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        rejectUnknownKeys(req.query as Record<string, unknown>, []);
        const serialized = db.transaction(() => {
          requirePublicScope(db, req.publicAccess!, sessionId);
          const session = findSession(db, sessionId)!;
          const stats = publicSnapshotLogStats(db, sessionId);
          if (stats.count > MAX_PUBLIC_SNAPSHOT_LOGS) {
            throw new AppError(
              413,
              'PUBLIC_SNAPSHOT_TOO_LARGE',
              'Public snapshot exceeds the supported Log limit',
              {
                maximumLogs: MAX_PUBLIC_SNAPSHOT_LOGS,
                maximumBytes: MAX_PUBLIC_SNAPSHOT_BYTES,
              },
            );
          }
          const emptyResponse = {
            protocolVersion: 1,
            session: publicSessionDto(session),
            highWatermarkSeq: session.event_seq,
            logs: [] as ReturnType<typeof publicLogDto>[],
          };
          const estimatedBytes = Buffer.byteLength(JSON.stringify(emptyResponse), 'utf8') +
            stats.serializedBytes + Math.max(0, stats.count - 1);
          if (estimatedBytes > MAX_PUBLIC_SNAPSHOT_BYTES) {
            throw new AppError(
              413,
              'PUBLIC_SNAPSHOT_TOO_LARGE',
              'Public snapshot exceeds the supported serialized size',
              {
                maximumLogs: MAX_PUBLIC_SNAPSHOT_LOGS,
                maximumBytes: MAX_PUBLIC_SNAPSHOT_BYTES,
              },
            );
          }
          const logs = db.prepare(`
            SELECT * FROM logs
            WHERE session_id = ? AND deleted_at IS NULL
            ORDER BY time, sync_id
          `).all(sessionId) as PublicLogRow[];
          const response = {
            ...emptyResponse,
            logs: logs.map(publicLogDto),
          };
          const json = JSON.stringify(response);
          if (Buffer.byteLength(json, 'utf8') > MAX_PUBLIC_SNAPSHOT_BYTES) {
            throw new AppError(
              413,
              'PUBLIC_SNAPSHOT_TOO_LARGE',
              'Public snapshot exceeds the supported serialized size',
              {
                maximumLogs: MAX_PUBLIC_SNAPSHOT_LOGS,
                maximumBytes: MAX_PUBLIC_SNAPSHOT_BYTES,
              },
            );
          }
          return json;
        }).deferred();
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Vary', 'Authorization');
        res.type('application/json').send(serialized);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/:sessionId/ws-ticket',
    ...(config.rateLimitEnabled ? [ticketIpLimiter] : []),
    publicAuth,
    ...(config.rateLimitEnabled ? [ticketShareLimiter] : []),
    (req: PublicAccessRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['afterSeq']);
        const afterSeq = nonNegativeInteger(body.afterSeq, 'afterSeq');
        const ticket = randomBytes(32).toString('base64url');
        const now = new Date();
        const result = runImmediate(db, () => {
          const share = requirePublicScope(db, req.publicAccess!, sessionId);
          if (afterSeq < share.min_retained_seq) {
            throw new AppError(
              410,
              'CURSOR_EXPIRED',
              'The event cursor is no longer available; fetch a new public snapshot',
              { minAvailableSeq: share.min_retained_seq, headSeq: share.event_seq },
            );
          }
          if (afterSeq > share.event_seq) {
            throw new AppError(
              422,
              'VALIDATION_FAILED',
              'afterSeq cannot be ahead of the Session',
            );
          }
          if (share.event_seq - afterSeq > MAX_PUBLIC_WS_BACKLOG_EVENTS) {
            throw new AppError(
              409,
              'PUBLIC_SNAPSHOT_REQUIRED',
              'Public WebSocket backlog is too large; fetch a new snapshot',
            );
          }
          const authorizationExpiresAt = [
            req.publicAccess!.expiresAt,
            share.expires_at,
          ].sort()[0];
          const expiresAt = new Date(Math.min(
            now.getTime() + 60_000,
            Date.parse(authorizationExpiresAt),
          )).toISOString();
          const nowIso = now.toISOString();
          if (expiresAt <= nowIso) invalidPublicAccess();
          db.prepare(`
            DELETE FROM public_ws_tickets
            WHERE consumed_at IS NULL AND expires_at <= ?
          `).run(nowIso);
          db.prepare(`
            DELETE FROM public_ws_tickets WHERE consumed_at IS NOT NULL
          `).run();
          const pendingForShare = Number(db.prepare(`
            SELECT COUNT(*)
            FROM public_ws_tickets
            WHERE public_share_id = ? AND consumed_at IS NULL AND expires_at > ?
          `).pluck().get(share.id, nowIso));
          const pendingForAccessToken = Number(db.prepare(`
            SELECT COUNT(*)
            FROM public_ws_tickets
            WHERE access_token_id = ? AND consumed_at IS NULL AND expires_at > ?
          `).pluck().get(req.publicAccess!.tokenId, nowIso));
          if (
            pendingForShare >= MAX_PENDING_PUBLIC_WS_TICKETS_PER_SHARE ||
            pendingForAccessToken >= MAX_PENDING_PUBLIC_WS_TICKETS_PER_ACCESS_TOKEN
          ) {
            throw new AppError(
              429,
              'PUBLIC_WS_TICKET_LIMIT_REACHED',
              'Too many unconsumed public WebSocket tickets',
              {
                maximumPerShare: MAX_PENDING_PUBLIC_WS_TICKETS_PER_SHARE,
                maximumPerAccessToken: MAX_PENDING_PUBLIC_WS_TICKETS_PER_ACCESS_TOKEN,
              },
            );
          }
          db.prepare(`
            INSERT INTO public_ws_tickets (
              id, token_hash, public_share_id, access_token_id, after_seq,
              authorization_expires_at, issued_ip, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            hashPublicWsTicket(ticket),
            share.id,
            req.publicAccess!.tokenId,
            afterSeq,
            authorizationExpiresAt,
            req.ip,
            nowIso,
            expiresAt,
          );
          return { ticket, expiresAt, sessionId, afterSeq };
        });
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Vary', 'Authorization');
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
