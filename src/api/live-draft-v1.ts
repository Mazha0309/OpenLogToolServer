import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { RequestHandler, Router } from 'express';
import { AppConfig } from '../config';
import { MembershipRow, normalizeStableId, requireMembership, SessionRow } from '../collaboration/access';
import { appendSessionEvent, CollaborationEvent } from '../collaboration/events';
import { computeRequestHash, readStoredResponse, requireIdempotencyKey, storeResponse } from '../collaboration/idempotency';
import {
  EMPTY_FIELD_REVISIONS,
  getLiveDraftLockManager,
  isLiveDraftField,
  LIVE_DRAFT_FIELDS,
  LiveDraftField,
} from '../collaboration/live-draft';
import { getRealtimeHub } from '../collaboration/realtime';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import { getRuntimeMetrics } from '../operations/metrics';
import { optionalUuid, rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';

export interface LiveDraftV1Dependencies {
  db: Database.Database;
  config: AppConfig;
}

interface LiveDraftRow {
  session_id: string;
  draft_id: string;
  version: number;
  time: string | null;
  controller: string | null;
  callsign: string | null;
  rst_sent: string | null;
  rst_rcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
  field_revisions_json: string;
  last_updated_by: string | null;
  last_updated_username: string | null;
  created_at: string;
  last_updated_at: string;
  last_committed_draft_id: string | null;
  last_committed_version: number | null;
  last_committed_by: string | null;
  last_committed_at: string | null;
  last_committed_sync_id: string | null;
}

interface LogRow {
  id: number;
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

interface DeviceStateRow {
  last_client_seq: number;
  request_hash: string;
}

interface ParsedUpdate {
  field: LiveDraftField;
  value: string | null;
  expectedRevision: number;
  leaseId: string;
}

const FIELD_COLUMNS: Readonly<Record<LiveDraftField, string>> = {
  time: 'time',
  controller: 'controller',
  callsign: 'callsign',
  rstSent: 'rst_sent',
  rstRcvd: 'rst_rcvd',
  qth: 'qth',
  device: 'device',
  power: 'power',
  antenna: 'antenna',
  height: 'height',
  remarks: 'remarks',
};

const TEXT_LIMITS: Readonly<Record<LiveDraftField, number>> = {
  time: 64,
  controller: 32,
  callsign: 32,
  rstSent: 16,
  rstRcvd: 16,
  qth: 200,
  device: 200,
  power: 64,
  antenna: 200,
  height: 64,
  remarks: 2_000,
};

function noLimit(): RequestHandler {
  return (_req, _res, next) => next();
}

function uuidField(body: Record<string, unknown>, field: string): string {
  const value = optionalUuid(body, field);
  if (!value) throw new AppError(422, 'VALIDATION_FAILED', `${field} is required`, { field });
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a positive integer`, { field });
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a non-negative integer`, { field });
  }
  return Number(value);
}

function validateTimestamp(value: string, field: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (!match || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(Date.parse(value))) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be an RFC 3339 timestamp`, { field });
  }
  return value;
}

function canonicalFieldValue(field: LiveDraftField, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a string or null`, { field });
  }
  if (value.length > TEXT_LIMITS[field]) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} is too long`, { field, max: TEXT_LIMITS[field] });
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (field === 'time') return validateTimestamp(normalized, field);
  if (field === 'controller' || field === 'callsign') return normalized.toUpperCase();
  return normalized;
}

function parseUpdates(raw: unknown): ParsedUpdate[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > LIVE_DRAFT_FIELDS.length) {
    throw new AppError(422, 'VALIDATION_FAILED', `updates must contain between 1 and ${LIVE_DRAFT_FIELDS.length} fields`);
  }
  const seen = new Set<LiveDraftField>();
  return raw.map((item, index) => {
    const update = requireJsonObject(item);
    rejectUnknownKeys(update, ['field', 'value', 'expectedRevision', 'leaseId']);
    if (!isLiveDraftField(update.field)) {
      throw new AppError(422, 'VALIDATION_FAILED', 'updates[].field is not supported', { index, field: update.field });
    }
    if (seen.has(update.field)) {
      throw new AppError(422, 'VALIDATION_FAILED', 'A field can be updated only once per request', { field: update.field });
    }
    seen.add(update.field);
    if (!Object.prototype.hasOwnProperty.call(update, 'value')) {
      throw new AppError(422, 'VALIDATION_FAILED', 'updates[].value is required', { index });
    }
    return {
      field: update.field,
      value: canonicalFieldValue(update.field, update.value),
      expectedRevision: nonNegativeInteger(update.expectedRevision, `updates[${index}].expectedRevision`),
      leaseId: normalizeStableId(update.leaseId, `updates[${index}].leaseId`),
    };
  });
}

function requireDraftAccess(
  db: Database.Database,
  sessionId: string,
  userId: string,
  writable: boolean,
): { session: SessionRow; membership: MembershipRow } {
  const access = requireMembership(db, sessionId, userId, writable ? ['owner', 'editor'] : undefined);
  if (access.session.status === 'initializing' && access.membership.role !== 'owner') {
    throw new AppError(404, 'NOT_FOUND', 'Resource not found');
  }
  if (access.session.status === 'initializing') {
    throw new AppError(
      409,
      'SESSION_NOT_ACTIVE',
      'Live drafts are unavailable until the Session is active',
    );
  }
  if (writable && access.session.status !== 'active') {
    throw new AppError(409, access.session.status === 'closed' ? 'SESSION_CLOSED' : 'SESSION_NOT_ACTIVE', 'Live drafts can only be changed in an active Session');
  }
  return access;
}

function previousLog(db: Database.Database, sessionId: string): LogRow | undefined {
  return db.prepare(`
    SELECT * FROM logs
    WHERE session_id = ? AND deleted_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(sessionId) as LogRow | undefined;
}

function ensureDraft(db: Database.Database, sessionId: string): void {
  if (db.prepare('SELECT 1 FROM session_live_drafts WHERE session_id = ?').get(sessionId)) return;
  const previous = previousLog(db, sessionId);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO session_live_drafts (
      session_id, draft_id, version, time, controller, rst_sent, rst_rcvd,
      field_revisions_json, created_at, last_updated_at
    ) VALUES (?, ?, 1, ?, ?, '59', '59', ?, ?, ?)
  `).run(sessionId, randomUUID(), now, previous?.controller ?? null, JSON.stringify(EMPTY_FIELD_REVISIONS), now, now);
}

function readDraft(db: Database.Database, sessionId: string): LiveDraftRow {
  const row = db.prepare(`
    SELECT d.*, u.username AS last_updated_username
    FROM session_live_drafts d
    LEFT JOIN users u ON u.id = d.last_updated_by
    WHERE d.session_id = ?
  `).get(sessionId) as LiveDraftRow | undefined;
  if (!row) throw new AppError(500, 'LIVE_DRAFT_MISSING', 'Live draft state is not initialized');
  return row;
}

function revisions(row: LiveDraftRow): Record<LiveDraftField, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.field_revisions_json);
  } catch {
    throw new AppError(500, 'LIVE_DRAFT_CORRUPT', 'Live draft field revisions are invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(500, 'LIVE_DRAFT_CORRUPT', 'Live draft field revisions are invalid');
  }
  const result = {} as Record<LiveDraftField, number>;
  for (const field of LIVE_DRAFT_FIELDS) {
    const value = (parsed as Record<string, unknown>)[field];
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new AppError(500, 'LIVE_DRAFT_CORRUPT', 'Live draft field revisions are invalid');
    }
    result[field] = Number(value);
  }
  return result;
}

function draftDto(row: LiveDraftRow) {
  return {
    draftId: row.draft_id,
    sessionId: row.session_id,
    version: Number(row.version),
    fields: {
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
    },
    fieldRevisions: revisions(row),
    lastUpdatedBy: row.last_updated_by ? {
      userId: row.last_updated_by,
      username: row.last_updated_username,
    } : null,
    createdAt: row.created_at,
    lastUpdatedAt: row.last_updated_at,
  };
}

function logDto(row: LogRow) {
  return {
    syncId: row.sync_id,
    sessionId: row.session_id,
    version: Number(row.version),
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

function draftEnvelope(db: Database.Database, sessionId: string) {
  const count = Number(db.prepare(`
    SELECT COUNT(*) FROM logs WHERE session_id = ? AND deleted_at IS NULL
  `).pluck().get(sessionId));
  const previous = previousLog(db, sessionId);
  return {
    draft: draftDto(readDraft(db, sessionId)),
    locks: getLiveDraftLockManager(db).list(sessionId),
    currentOrdinal: count + 1,
    totalRecords: count,
    previousRecord: previous ? logDto(previous) : null,
  };
}

function resetDraft(
  db: Database.Database,
  current: LiveDraftRow,
  actorUserId: string,
  input?: { committedSyncId: string; committedAt: string },
): LiveDraftRow {
  const now = input?.committedAt ?? new Date().toISOString();
  const nextDraftId = randomUUID();
  const reset = db.prepare(`
    UPDATE session_live_drafts
    SET draft_id = ?, version = version + 1, time = ?, controller = ?, callsign = NULL,
        rst_sent = '59', rst_rcvd = '59', qth = NULL, device = NULL, power = NULL,
        antenna = NULL, height = NULL, remarks = NULL, field_revisions_json = ?,
        last_updated_by = ?, created_at = ?, last_updated_at = ?,
        last_committed_draft_id = ?, last_committed_version = ?,
        last_committed_by = ?, last_committed_at = ?, last_committed_sync_id = ?
    WHERE session_id = ? AND version = ?
  `).run(
    nextDraftId,
    now,
    current.controller,
    JSON.stringify(EMPTY_FIELD_REVISIONS),
    actorUserId,
    now,
    now,
    input ? current.draft_id : current.last_committed_draft_id,
    input ? current.version : current.last_committed_version,
    input ? actorUserId : current.last_committed_by,
    input ? now : current.last_committed_at,
    input ? input.committedSyncId : current.last_committed_sync_id,
    current.session_id,
    current.version,
  );
  if (reset.changes !== 1) {
    throw new AppError(409, 'LIVE_DRAFT_VERSION_CONFLICT', 'The live draft changed concurrently');
  }
  // A replay response belongs to one draft generation. Removing these bounded
  // rows on generation change prevents a late PATCH retry from regressing a
  // client to the just-committed or discarded draft.
  db.prepare('DELETE FROM live_draft_device_state WHERE session_id = ?').run(current.session_id);
  return readDraft(db, current.session_id);
}

function assertNoForeignLocks(
  db: Database.Database,
  sessionId: string,
  userId: string,
  deviceId: string,
): void {
  const locks = getLiveDraftLockManager(db).list(sessionId)
    .filter((lock) => lock.userId !== userId || lock.deviceId !== deviceId);
  if (locks.length === 0) return;
  throw new AppError(
    409,
    'LIVE_DRAFT_BUSY',
    'Another member is still editing the live draft',
    {
      locks: locks.map((lock) => ({
        field: lock.field,
        holder: { userId: lock.userId, username: lock.username },
        expiresAt: lock.expiresAt,
      })),
    },
  );
}

function username(db: Database.Database, userId: string): string {
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  if (!row) throw new AppError(401, 'TOKEN_INVALID', 'Access token user no longer exists');
  return row.username;
}

export function createLiveDraftV1Router(dependencies: LiveDraftV1Dependencies): Router {
  const { db, config } = dependencies;
  const router = Router();
  const hub = getRealtimeHub(db);
  const lockManager = getLiveDraftLockManager(db);
  const metrics = getRuntimeMetrics(db);
  const readLimiter = createMemoryRateLimiter({ windowMs: 60_000, max: 120, keyGenerator: (req) => `${(req as V1AuthRequest).auth?.userId ?? 'anonymous'}:${req.ip}:${req.params.sessionId ?? ''}`, message: 'Too many live draft reads' });
  const lockLimiter = createMemoryRateLimiter({ windowMs: 60_000, max: 180, keyGenerator: (req) => `${(req as V1AuthRequest).auth?.userId ?? 'anonymous'}:${req.ip}:${req.params.sessionId ?? ''}`, message: 'Too many live draft lock requests' });
  const updateLimiter = createMemoryRateLimiter({ windowMs: 60_000, max: 600, keyGenerator: (req) => `${(req as V1AuthRequest).auth?.userId ?? 'anonymous'}:${req.ip}:${req.params.sessionId ?? ''}`, message: 'Too many live draft updates' });
  const commitLimiter = createMemoryRateLimiter({ windowMs: 60_000, max: 60, keyGenerator: (req) => `${(req as V1AuthRequest).auth?.userId ?? 'anonymous'}:${req.ip}:${req.params.sessionId ?? ''}`, message: 'Too many live draft commits' });
  router.use(createAccessTokenMiddleware(config, db));

  router.get('/:sessionId/live-draft', config.rateLimitEnabled ? readLimiter : noLimit(), (req: V1AuthRequest, res, next) => {
    try {
      rejectUnknownKeys(req.query as Record<string, unknown>, []);
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const response = db.transaction(() => {
        requireDraftAccess(db, sessionId, req.auth!.userId, false);
        ensureDraft(db, sessionId);
        return draftEnvelope(db, sessionId);
      }).deferred();
      metrics.recordLiveDraftRead();
      res.setHeader('Cache-Control', 'no-store');
      res.json(response);
    } catch (error) { next(error); }
  });

  router.post('/:sessionId/live-draft/locks', config.rateLimitEnabled ? lockLimiter : noLimit(), (req: V1AuthRequest, res, next) => {
    try {
      rejectUnknownKeys(req.query as Record<string, unknown>, []);
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['field', 'deviceId']);
      if (!isLiveDraftField(body.field)) throw new AppError(422, 'VALIDATION_FAILED', 'field is not supported', { field: body.field });
      const deviceId = uuidField(body, 'deviceId');
      requireDraftAccess(db, sessionId, req.auth!.userId, true);
      let acquired;
      try {
        acquired = lockManager.acquire({ sessionId, field: body.field, userId: req.auth!.userId, username: username(db, req.auth!.userId), deviceId });
      } catch (error) {
        if (error instanceof AppError && error.code === 'LIVE_DRAFT_FIELD_LOCKED') metrics.recordLiveDraftLock('conflict');
        throw error;
      }
      metrics.recordLiveDraftLock(acquired.reused ? 'renewed' : 'acquired');
      const occurredAt = new Date().toISOString();
      hub.publishControl({ type: 'liveDraft.lockChanged', sessionId, occurredAt, action: acquired.reused ? 'renewed' : 'acquired', lock: acquired.lock });
      res.status(201).json({ lock: acquired.lock });
    } catch (error) { next(error); }
  });

  router.post('/:sessionId/live-draft/locks/:leaseId/renew', config.rateLimitEnabled ? lockLimiter : noLimit(), (req: V1AuthRequest, res, next) => {
    try {
      rejectUnknownKeys(req.query as Record<string, unknown>, []);
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const leaseId = normalizeStableId(req.params.leaseId, 'leaseId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['deviceId']);
      const deviceId = uuidField(body, 'deviceId');
      requireDraftAccess(db, sessionId, req.auth!.userId, true);
      const lock = lockManager.renew({ sessionId, leaseId, userId: req.auth!.userId, deviceId });
      metrics.recordLiveDraftLock('renewed');
      hub.publishControl({ type: 'liveDraft.lockChanged', sessionId, occurredAt: new Date().toISOString(), action: 'renewed', lock });
      res.json({ lock });
    } catch (error) { next(error); }
  });

  router.delete('/:sessionId/live-draft/locks/:leaseId', config.rateLimitEnabled ? lockLimiter : noLimit(), (req: V1AuthRequest, res, next) => {
    try {
      rejectUnknownKeys(req.query as Record<string, unknown>, []);
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const leaseId = normalizeStableId(req.params.leaseId, 'leaseId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['deviceId']);
      const deviceId = uuidField(body, 'deviceId');
      requireDraftAccess(db, sessionId, req.auth!.userId, true);
      const lock = lockManager.release({ sessionId, leaseId, userId: req.auth!.userId, deviceId });
      metrics.recordLiveDraftLock('released');
      hub.publishControl({ type: 'liveDraft.lockChanged', sessionId, occurredAt: new Date().toISOString(), action: 'released', field: lock.field, leaseId: lock.leaseId });
      res.json({ released: true });
    } catch (error) { next(error); }
  });

  router.patch('/:sessionId/live-draft', config.rateLimitEnabled ? updateLimiter : noLimit(), (req: V1AuthRequest, res, next) => {
    try {
      rejectUnknownKeys(req.query as Record<string, unknown>, []);
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['deviceId', 'clientSeq', 'updates']);
      const deviceId = uuidField(body, 'deviceId');
      const clientSeq = positiveInteger(body.clientSeq, 'clientSeq');
      const updates = parseUpdates(body.updates);
      const requestHash = computeRequestHash('PATCH', `/api/v1/sessions/${sessionId}/live-draft`, body);
      const result = db.transaction(() => {
        requireDraftAccess(db, sessionId, req.auth!.userId, true);
        ensureDraft(db, sessionId);
        const current = readDraft(db, sessionId);
        const state = db.prepare(`SELECT last_client_seq, request_hash FROM live_draft_device_state WHERE session_id = ? AND user_id = ? AND device_id = ?`).get(sessionId, req.auth!.userId, deviceId) as DeviceStateRow | undefined;
        if (state && Number(state.last_client_seq) === clientSeq) {
          if (state.request_hash !== requestHash) throw new AppError(409, 'LIVE_DRAFT_CLIENT_SEQ_REUSED', 'clientSeq was already used for a different update', { clientSeq });
          // Confirm the original update without returning a now-stale draft if
          // another device advanced this same generation in the meantime.
          return {
            body: {
              draft: draftDto(current),
              appliedClientSeq: clientSeq,
              replayed: true,
            },
            replayed: true,
          };
        }
        if (state && clientSeq !== Number(state.last_client_seq) + 1) {
          throw new AppError(409, 'LIVE_DRAFT_CLIENT_SEQ_GAP', 'clientSeq must advance serially', { expectedClientSeq: Number(state.last_client_seq) + 1, receivedClientSeq: clientSeq });
        }
        const fieldRevisions = revisions(current);
        for (const update of updates) {
          lockManager.assertLease({ sessionId, field: update.field, leaseId: update.leaseId, userId: req.auth!.userId, deviceId });
          if (fieldRevisions[update.field] !== update.expectedRevision) {
            throw new AppError(409, 'LIVE_DRAFT_FIELD_CONFLICT', 'The live draft field changed concurrently', { field: update.field, currentRevision: fieldRevisions[update.field], draftVersion: current.version });
          }
          fieldRevisions[update.field] += 1;
        }
        const assignments = updates.map((update) => `${FIELD_COLUMNS[update.field]} = ?`);
        const now = new Date().toISOString();
        const changed = db.prepare(`UPDATE session_live_drafts SET ${assignments.join(', ')}, field_revisions_json = ?, version = version + 1, last_updated_by = ?, last_updated_at = ? WHERE session_id = ? AND version = ?`).run(...updates.map((update) => update.value), JSON.stringify(fieldRevisions), req.auth!.userId, now, sessionId, current.version);
        if (changed.changes !== 1) throw new AppError(409, 'LIVE_DRAFT_VERSION_CONFLICT', 'The live draft changed concurrently');
        const response = { draft: draftDto(readDraft(db, sessionId)), appliedClientSeq: clientSeq };
        db.prepare(`INSERT INTO live_draft_device_state (session_id, user_id, device_id, last_client_seq, request_hash, response_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, user_id, device_id) DO UPDATE SET last_client_seq = excluded.last_client_seq, request_hash = excluded.request_hash, response_json = excluded.response_json, updated_at = excluded.updated_at`).run(sessionId, req.auth!.userId, deviceId, clientSeq, requestHash, JSON.stringify(response), now);
        return { body: { ...response, replayed: false }, replayed: false };
      }).immediate();
      metrics.recordLiveDraftUpdate(updates.length, result.replayed);
      if (!result.replayed) hub.publishControl({ type: 'liveDraft.updated', sessionId, occurredAt: new Date().toISOString(), actor: { userId: req.auth!.userId, username: username(db, req.auth!.userId) }, draft: (result.body as { draft: unknown }).draft });
      res.json(result.body);
    } catch (error) { next(error); }
  });

  router.post('/:sessionId/live-draft/commit', config.rateLimitEnabled ? commitLimiter : noLimit(), (req: V1AuthRequest, res, next) => {
    try {
      rejectUnknownKeys(req.query as Record<string, unknown>, []);
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['deviceId', 'expectedDraftVersion', 'syncId']);
      const deviceId = uuidField(body, 'deviceId');
      const expectedDraftVersion = positiveInteger(body.expectedDraftVersion, 'expectedDraftVersion');
      const syncId = normalizeStableId(body.syncId, 'syncId');
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash('POST', `/api/v1/sessions/${sessionId}/live-draft/commit`, body);
      const committed = db.transaction(() => {
        requireDraftAccess(db, sessionId, req.auth!.userId, true);
        const stored = readStoredResponse(db, mutationId, req.auth!.userId, requestHash);
        if (stored) return { status: stored.status, body: stored.body as Record<string, unknown>, replayed: true as const };
        ensureDraft(db, sessionId);
        const current = readDraft(db, sessionId);
        assertNoForeignLocks(db, sessionId, req.auth!.userId, deviceId);
        if (Number(current.version) !== expectedDraftVersion) {
          if (Number(current.last_committed_version) === expectedDraftVersion) {
            const committedBy = current.last_committed_by ? username(db, current.last_committed_by) : null;
            throw new AppError(409, 'LIVE_DRAFT_ALREADY_COMMITTED', 'The live draft was already committed', { committedBy: current.last_committed_by ? { userId: current.last_committed_by, username: committedBy } : null, committedAt: current.last_committed_at, syncId: current.last_committed_sync_id, currentDraftId: current.draft_id, currentDraftVersion: current.version });
          }
          throw new AppError(409, 'LIVE_DRAFT_VERSION_CONFLICT', 'The live draft changed concurrently', { currentDraftId: current.draft_id, currentDraftVersion: current.version });
        }
        const missingFields = (['time', 'controller', 'callsign'] as const).filter((field) => !current[field]);
        if (missingFields.length > 0) throw new AppError(409, 'LIVE_DRAFT_INCOMPLETE', 'The live draft is missing required fields', { missingFields });
        if (db.prepare('SELECT 1 FROM logs WHERE session_id = ? AND sync_id = ?').get(sessionId, syncId)) throw new AppError(409, 'LOG_ALREADY_EXISTS', 'A Log with this syncId already exists');
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO logs (sync_id, session_id, version, time, controller, callsign, rst_sent, rst_rcvd, qth, device, power, antenna, height, remarks, created_at, updated_at, created_by, updated_by, source_device_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(syncId, sessionId, current.time, current.controller, current.callsign, current.rst_sent, current.rst_rcvd, current.qth, current.device, current.power, current.antenna, current.height, current.remarks, now, now, req.auth!.userId, req.auth!.userId, deviceId);
        const record = db.prepare('SELECT * FROM logs WHERE session_id = ? AND sync_id = ?').get(sessionId, syncId) as LogRow;
        const recordBody = logDto(record);
        const event = appendSessionEvent(db, { sessionId, type: 'log.created', entityType: 'log', entityId: syncId, entityVersion: 1, mutationId, actorUserId: req.auth!.userId, actorDeviceId: deviceId, payload: recordBody, occurredAt: now });
        const next = resetDraft(db, current, req.auth!.userId, { committedSyncId: syncId, committedAt: now });
        const totalRecords = Number(db.prepare(`SELECT COUNT(*) FROM logs WHERE session_id = ? AND deleted_at IS NULL`).pluck().get(sessionId));
        const response = { record: recordBody, event, committedDraftId: current.draft_id, nextDraft: draftDto(next), committedOrdinal: totalRecords, currentOrdinal: totalRecords + 1, totalRecords };
        storeResponse(db, { mutationId, sessionId, userId: req.auth!.userId, deviceId, requestHash, status: 201, body: response });
        return { status: 201, body: response, event, replayed: false as const };
      }).immediate();
      if (committed.replayed) {
        res.setHeader('Idempotent-Replay', 'true');
      } else {
        lockManager.clearSession(sessionId);
        metrics.recordLiveDraftCommit(false);
        hub.publish(committed.event!);
        hub.publishControl({ type: 'liveDraft.committed', sessionId, occurredAt: committed.event!.occurredAt, committedBy: committed.event!.actor, committedDraftId: committed.body.committedDraftId, record: committed.body.record, nextDraft: committed.body.nextDraft, currentOrdinal: committed.body.currentOrdinal, totalRecords: committed.body.totalRecords });
      }
      res.status(committed.status).json(committed.body);
    } catch (error) {
      if (error instanceof AppError && ['LIVE_DRAFT_ALREADY_COMMITTED', 'LIVE_DRAFT_VERSION_CONFLICT'].includes(error.code)) metrics.recordLiveDraftCommit(true);
      next(error);
    }
  });

  router.delete('/:sessionId/live-draft', config.rateLimitEnabled ? commitLimiter : noLimit(), (req: V1AuthRequest, res, next) => {
    try {
      rejectUnknownKeys(req.query as Record<string, unknown>, []);
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['deviceId', 'expectedDraftVersion']);
      const deviceId = uuidField(body, 'deviceId');
      const expectedDraftVersion = positiveInteger(body.expectedDraftVersion, 'expectedDraftVersion');
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash('DELETE', `/api/v1/sessions/${sessionId}/live-draft`, body);
      const discarded = db.transaction(() => {
        requireDraftAccess(db, sessionId, req.auth!.userId, true);
        const stored = readStoredResponse(db, mutationId, req.auth!.userId, requestHash);
        if (stored) return { status: stored.status, body: stored.body as Record<string, unknown>, replayed: true as const };
        ensureDraft(db, sessionId);
        const current = readDraft(db, sessionId);
        assertNoForeignLocks(db, sessionId, req.auth!.userId, deviceId);
        if (Number(current.version) !== expectedDraftVersion) throw new AppError(409, 'LIVE_DRAFT_VERSION_CONFLICT', 'The live draft changed concurrently', { currentDraftId: current.draft_id, currentDraftVersion: current.version });
        const next = resetDraft(db, current, req.auth!.userId);
        const totalRecords = Number(db.prepare(`SELECT COUNT(*) FROM logs WHERE session_id = ? AND deleted_at IS NULL`).pluck().get(sessionId));
        const response = { discardedDraftId: current.draft_id, nextDraft: draftDto(next), currentOrdinal: totalRecords + 1, totalRecords };
        storeResponse(db, { mutationId, sessionId, userId: req.auth!.userId, deviceId, requestHash, status: 200, body: response });
        return { status: 200, body: response, replayed: false as const };
      }).immediate();
      if (discarded.replayed) res.setHeader('Idempotent-Replay', 'true');
      else {
        lockManager.clearSession(sessionId);
        metrics.recordLiveDraftDiscard();
        hub.publishControl({ type: 'liveDraft.cleared', sessionId, occurredAt: new Date().toISOString(), discardedBy: { userId: req.auth!.userId, username: username(db, req.auth!.userId) }, discardedDraftId: discarded.body.discardedDraftId, nextDraft: discarded.body.nextDraft });
      }
      res.status(discarded.status).json(discarded.body);
    } catch (error) { next(error); }
  });

  return router;
}

export const liveDraftV1Internals = {
  canonicalFieldValue,
  draftDto,
  ensureDraft,
  parseUpdates,
};
