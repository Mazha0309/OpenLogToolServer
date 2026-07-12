import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { Request, Response, Router } from 'express';
import { AppConfig, config } from '../config';
import {
  findMembership,
  findSession,
  normalizeStableId,
  requireMembership,
  sessionDto,
} from '../collaboration/access';
import {
  computeRequestHash,
  readStoredResponse,
  requireIdempotencyKey,
  storeResponse,
} from '../collaboration/idempotency';
import { appendSessionEvent, CollaborationEvent } from '../collaboration/events';
import { getRealtimeHub } from '../collaboration/realtime';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';

interface SessionsV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

interface LogRow {
  sync_id: string;
  session_id: string;
  version: number;
  time: string;
  controller: string;
  callsign: string;
  rst_sent: string | null;
  rst_rcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface BootstrapLog {
  syncId: string;
  time: string;
  controller: string;
  callsign: string;
  rstSent: string | null;
  rstRcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
}

const LOG_FIELDS = [
  'syncId',
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

function nullableText(
  value: Record<string, unknown>,
  field: string,
  max: number,
): string | null {
  const raw = value[field];
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a string or null`, {
      field,
    });
  }
  if (raw.length > max) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} is too long`, { field, max });
  }
  return raw.trim() === '' ? null : raw;
}

function validateBootstrapLog(value: unknown, index: number): BootstrapLog {
  const item = requireJsonObject(value);
  rejectUnknownKeys(item, LOG_FIELDS);
  const time = requireString(item, 'time', { min: 1, max: 64 });
  if (!Number.isFinite(Date.parse(time))) {
    throw new AppError(422, 'VALIDATION_FAILED', 'time must be an RFC 3339 timestamp', {
      field: `items[${index}].time`,
    });
  }
  return {
    syncId: normalizeStableId(item.syncId, `items[${index}].syncId`),
    // Preserve the client's RFC 3339 representation byte-for-byte. The timestamp is
    // validated above; rewriting it here would make a publish/snapshot round trip lossy.
    time,
    controller: requireString(item, 'controller', { min: 1, max: 32 }).toUpperCase(),
    callsign: requireString(item, 'callsign', { min: 1, max: 32 }).toUpperCase(),
    rstSent: nullableText(item, 'rstSent', 16),
    rstRcvd: nullableText(item, 'rstRcvd', 16),
    qth: nullableText(item, 'qth', 200),
    device: nullableText(item, 'device', 200),
    power: nullableText(item, 'power', 64),
    antenna: nullableText(item, 'antenna', 200),
    height: nullableText(item, 'height', 64),
    remarks: nullableText(item, 'remarks', 2_000),
  };
}

function logDto(row: LogRow) {
  return {
    syncId: row.sync_id,
    sessionId: row.session_id,
    version: row.version,
    time: row.time,
    controller: row.controller,
    callsign: row.callsign,
    rstSent: row.rst_sent,
    rstRcvd: row.rst_rcvd,
    qth: row.qth,
    device: row.device,
    power: row.power,
    antenna: row.antenna,
    height: row.height,
    remarks: row.remarks,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function sameBootstrapLog(row: LogRow, item: BootstrapLog): boolean {
  return (
    row.time === item.time &&
    row.controller === item.controller &&
    row.callsign === item.callsign &&
    row.rst_sent === item.rstSent &&
    row.rst_rcvd === item.rstRcvd &&
    row.qth === item.qth &&
    row.device === item.device &&
    row.power === item.power &&
    row.antenna === item.antenna &&
    row.height === item.height &&
    row.remarks === item.remarks
  );
}

function sessionEventPayload(row: NonNullable<ReturnType<typeof findSession>>) {
  return {
    sessionId: row.id,
    title: row.title,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    deletedAt: row.deleted_at,
  };
}

function deviceId(req: Request): string | undefined {
  const value = req.header('x-device-id');
  return value ? normalizeStableId(value, 'X-Device-Id') : undefined;
}

function replayResponse(
  res: Response,
  stored: { status: number; body: unknown },
) {
  res.setHeader('Idempotent-Replay', 'true');
  res.status(stored.status).json(stored.body);
}

export function createSessionsV1Router(dependencies: SessionsV1Dependencies = {}): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const requireAccessToken = createAccessTokenMiddleware(runtimeConfig);

  router.use(requireAccessToken);

  router.get('/', (req: V1AuthRequest, res, next) => {
    try {
      const rows = database().prepare(`
        SELECT s.*, sm.role
        FROM sessions s
        JOIN session_members sm ON sm.session_id = s.id
        WHERE sm.user_id = ? AND sm.removed_at IS NULL AND s.deleted_at IS NULL
        ORDER BY s.created_at DESC
      `).all(req.auth!.userId) as Array<ReturnType<typeof findSession> & { role: any }>;
      res.json(
        rows.map((row) => sessionDto(row as NonNullable<ReturnType<typeof findSession>>, row.role)),
      );
    } catch (error) {
      next(error);
    }
  });

  router.put('/:sessionId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['title']);
      const title = requireString(body, 'title', { min: 1, max: 200 });
      const mutationId = requireIdempotencyKey(req);
      const hash = computeRequestHash(req.method, req.baseUrl + req.path, body);
      const db = database();

      const stored = readStoredResponse(db, mutationId, req.auth!.userId, hash);
      if (stored) {
        replayResponse(res, stored);
        return;
      }

      let status = 201;
      let response: unknown;
      const transaction = db.transaction(() => {
        const replay = readStoredResponse(db, mutationId, req.auth!.userId, hash);
        if (replay) return replay;

        const existing = findSession(db, sessionId);
        if (existing) {
          const membership = findMembership(db, sessionId, req.auth!.userId);
          if (!membership || membership.role !== 'owner') {
            throw new AppError(409, 'SESSION_ID_UNAVAILABLE', 'Session ID is unavailable');
          }
          if (existing.deleted_at) {
            throw new AppError(410, 'SESSION_DELETED', 'Session has been deleted', {
              deletedAt: existing.deleted_at,
              finalSeq: existing.event_seq,
            });
          }
          if (existing.title !== title) {
            throw new AppError(
              409,
              'SESSION_ALREADY_EXISTS',
              'Session already exists with different metadata',
            );
          }
          status = 200;
          response = { session: sessionDto(existing, membership.role) };
        } else {
          const now = new Date().toISOString();
          db.prepare(`
            INSERT INTO sessions (
              id, title, status, owner_user_id, version, event_seq,
              min_retained_seq, created_at, updated_at
            ) VALUES (?, ?, 'initializing', ?, 1, 0, 0, ?, ?)
          `).run(sessionId, title, req.auth!.userId, now, now);
          db.prepare(`
            INSERT INTO session_members (
              id, session_id, user_id, role, version, created_at, updated_at
            ) VALUES (?, ?, ?, 'owner', 1, ?, ?)
          `).run(randomUUID(), sessionId, req.auth!.userId, now, now);
          const created = findSession(db, sessionId)!;
          response = { session: sessionDto(created, 'owner') };
        }

        storeResponse(db, {
          mutationId,
          sessionId,
          userId: req.auth!.userId,
          deviceId: deviceId(req),
          requestHash: hash,
          status,
          body: response,
        });
        return { status, body: response };
      });
      const result = transaction.immediate();
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:sessionId/bootstrap/logs', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['items']);
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 500) {
        throw new AppError(422, 'VALIDATION_FAILED', 'items must contain between 1 and 500 logs');
      }
      const items = body.items.map(validateBootstrapLog);
      const mutationId = requireIdempotencyKey(req);
      const hash = computeRequestHash(req.method, req.baseUrl + req.path, body);
      const db = database();
      requireMembership(db, sessionId, req.auth!.userId, ['owner']);

      const stored = readStoredResponse(db, mutationId, req.auth!.userId, hash);
      if (stored) {
        replayResponse(res, stored);
        return;
      }

      const transaction = db.transaction(() => {
        const { session } = requireMembership(db, sessionId, req.auth!.userId, ['owner']);
        if (session.status !== 'initializing') {
          throw new AppError(
            409,
            'SESSION_NOT_INITIALIZING',
            'Bootstrap is closed for this Session',
          );
        }
        const replay = readStoredResponse(db, mutationId, req.auth!.userId, hash);
        if (replay) return replay;

        let inserted = 0;
        let existingCount = 0;
        const now = new Date().toISOString();
        const select = db.prepare('SELECT * FROM logs WHERE session_id = ? AND sync_id = ?');
        const insert = db.prepare(`
          INSERT INTO logs (
            sync_id, session_id, controller, callsign, time, rst_sent, rst_rcvd,
            qth, device, power, antenna, height, remarks, version,
            created_at, updated_at, created_by, updated_by, source_device_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `);

        for (const item of items) {
          const existing = select.get(sessionId, item.syncId) as LogRow | undefined;
          if (existing) {
            if (!sameBootstrapLog(existing, item)) {
              throw new AppError(
                409,
                'BOOTSTRAP_ENTITY_MISMATCH',
                'A bootstrap Log already exists with different content',
                { syncId: item.syncId },
              );
            }
            existingCount += 1;
            continue;
          }
          insert.run(
            item.syncId,
            sessionId,
            item.controller,
            item.callsign,
            item.time,
            item.rstSent,
            item.rstRcvd,
            item.qth,
            item.device,
            item.power,
            item.antenna,
            item.height,
            item.remarks,
            now,
            now,
            req.auth!.userId,
            req.auth!.userId,
            deviceId(req) ?? null,
          );
          inserted += 1;
        }
        const total = db
          .prepare('SELECT COUNT(*) AS count FROM logs WHERE session_id = ?')
          .get(sessionId) as { count: number };
        const response = {
          accepted: items.length,
          inserted,
          existing: existingCount,
          totalLogCount: Number(total.count),
        };
        storeResponse(db, {
          mutationId,
          sessionId,
          userId: req.auth!.userId,
          deviceId: deviceId(req),
          requestHash: hash,
          status: 200,
          body: response,
        });
        return { status: 200, body: response };
      });
      const result = transaction.immediate();
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:sessionId/activate', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['expectedLogCount']);
      if (!Number.isSafeInteger(body.expectedLogCount) || Number(body.expectedLogCount) < 0) {
        throw new AppError(422, 'VALIDATION_FAILED', 'expectedLogCount must be a non-negative integer');
      }
      const expectedLogCount = Number(body.expectedLogCount);
      const mutationId = requireIdempotencyKey(req);
      const hash = computeRequestHash(req.method, req.baseUrl + req.path, body);
      const db = database();
      requireMembership(db, sessionId, req.auth!.userId, ['owner']);

      const stored = readStoredResponse(db, mutationId, req.auth!.userId, hash);
      if (stored) {
        replayResponse(res, stored);
        return;
      }

      const transaction = db.transaction(() => {
        const { session, membership } = requireMembership(
          db,
          sessionId,
          req.auth!.userId,
          ['owner'],
        );
        const replay = readStoredResponse(db, mutationId, req.auth!.userId, hash);
        if (replay) return replay;
        const count = db.prepare('SELECT COUNT(*) AS count FROM logs WHERE session_id = ?').get(
          sessionId,
        ) as { count: number };
        if (Number(count.count) !== expectedLogCount) {
          throw new AppError(409, 'LOG_COUNT_MISMATCH', 'Bootstrap Log count does not match', {
            expectedLogCount,
            actualLogCount: Number(count.count),
          });
        }
        let event: CollaborationEvent | undefined;
        if (session.status === 'initializing') {
          const now = new Date().toISOString();
          db.prepare(`
            UPDATE sessions
            SET status = 'active', version = version + 1, updated_at = ?
            WHERE id = ?
          `).run(now, sessionId);
          const activatedBeforeEvent = findSession(db, sessionId)!;
          event = appendSessionEvent(db, {
            sessionId,
            type: 'session.activated',
            entityType: 'session',
            entityId: sessionId,
            entityVersion: activatedBeforeEvent.version,
            mutationId,
            actorUserId: req.auth!.userId,
            actorDeviceId: deviceId(req),
            payload: sessionEventPayload(activatedBeforeEvent),
            occurredAt: now,
          });
        } else if (session.status !== 'active') {
          throw new AppError(409, 'INVALID_SESSION_STATE', 'Session cannot be activated');
        }
        const activated = findSession(db, sessionId)!;
        const response = {
          session: sessionDto(activated, membership.role),
          highWatermarkSeq: activated.event_seq,
          logCount: Number(count.count),
        };
        storeResponse(db, {
          mutationId,
          sessionId,
          userId: req.auth!.userId,
          deviceId: deviceId(req),
          requestHash: hash,
          status: 200,
          body: response,
        });
        return { status: 200, body: response, event };
      });
      const result = transaction.immediate();
      if ('event' in result && result.event) getRealtimeHub(db).publish(result.event);
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:sessionId/snapshot', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const db = database();
      const transaction = db.transaction(() => {
        const { session, membership } = requireMembership(db, sessionId, req.auth!.userId);
        if (session.status === 'initializing' && membership.role !== 'owner') {
          throw new AppError(404, 'NOT_FOUND', 'Resource not found');
        }
        const logs = db.prepare(`
          SELECT * FROM logs
          WHERE session_id = ? AND deleted_at IS NULL
          ORDER BY time, sync_id
        `).all(sessionId) as LogRow[];
        return {
          protocolVersion: 1,
          session: sessionDto(session, membership.role),
          highWatermarkSeq: session.event_seq,
          logs: logs.map(logDto),
        };
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(transaction.deferred());
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const sessionsV1Router = createSessionsV1Router();
