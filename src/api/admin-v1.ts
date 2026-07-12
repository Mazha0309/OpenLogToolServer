import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import Database from 'better-sqlite3';
import { Response, Router } from 'express';
import { normalizeStableId } from '../collaboration/access';
import {
  computeRequestHash,
  readStoredResponse,
  requireIdempotencyKey,
  storeResponse,
} from '../collaboration/idempotency';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { getRequestId } from '../middleware/request-id';
import { rejectUnknownKeys, requireJsonObject } from '../utils/validation';

interface AdminV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

interface CurrentUserRow {
  role: string;
}

interface OverviewRow {
  instance_id: string | null;
  registration_enabled: number;
  user_total: number;
  admin_total: number;
  session_total: number;
  session_initializing: number;
  session_active: number;
  session_closed: number;
  session_deleted: number;
}

interface SettingsRow {
  registration_enabled: number;
}

interface UserRow {
  id: string;
  username: string;
  role: string;
  created_at: string;
  updated_at: string;
}

interface UsersQuery {
  q?: string;
  role?: 'admin' | 'user';
  page: number;
  pageSize: number;
}

type AdminRole = 'admin' | 'user';
type AdminAuditAction =
  | 'settings.registration.updated'
  | 'user.role.updated'
  | 'user.refresh_tokens.revoked'
  | 'session_events.pruned';

interface AdminAuditRow {
  id: string;
  action: AdminAuditAction;
  actor_user_id: string;
  target_user_id: string | null;
  request_id: string;
  mutation_id: string;
  before_json: string | null;
  after_json: string | null;
  details_json: string;
  occurred_at: string;
}

interface AuditQuery {
  action?: AdminAuditAction;
  actorUserId?: string;
  targetUserId?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: AuditCursor;
}

interface AuditCursor {
  v: 1;
  occurredAt: string;
  id: string;
  filterHash: string;
}

interface WriteResult {
  status: number;
  body: unknown;
  replay: boolean;
}

const USERS_QUERY_KEYS = ['q', 'role', 'page', 'pageSize'] as const;
const AUDIT_QUERY_KEYS = [
  'action',
  'actorUserId',
  'targetUserId',
  'from',
  'to',
  'cursor',
  'limit',
] as const;
const ADMIN_AUDIT_ACTIONS: readonly AdminAuditAction[] = [
  'settings.registration.updated',
  'user.role.updated',
  'user.refresh_tokens.revoked',
  'session_events.pruned',
];
const MAX_PAGE = 1_000_000;
const MAX_PAGE_SIZE = 100;
const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;

function validationError(message: string, details?: unknown): AppError {
  return new AppError(422, 'VALIDATION_FAILED', message, details);
}

function optionalScalarQuery(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const raw = value[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw validationError(`${field} must be a single string`, { field });
  }
  return raw;
}

function boundedPositiveInteger(
  raw: string | undefined,
  field: string,
  fallback: number,
  maximum: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw validationError(`${field} must be a positive integer`, { field });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw validationError(`${field} must be between 1 and ${maximum}`, {
      field,
      min: 1,
      max: maximum,
    });
  }
  return parsed;
}

function parseUsersQuery(rawQuery: V1AuthRequest['query']): UsersQuery {
  const query = rawQuery as Record<string, unknown>;
  rejectUnknownKeys(query, USERS_QUERY_KEYS);

  const rawSearch = optionalScalarQuery(query, 'q');
  const search = rawSearch?.trim();
  if (search && search.length > 64) {
    throw validationError('q must be at most 64 characters', {
      field: 'q',
      max: 64,
    });
  }

  const rawRole = optionalScalarQuery(query, 'role');
  if (rawRole !== undefined && rawRole !== 'admin' && rawRole !== 'user') {
    throw validationError('role must be admin or user', {
      field: 'role',
      allowed: ['admin', 'user'],
    });
  }

  return {
    ...(search ? { q: search } : {}),
    ...(rawRole ? { role: rawRole } : {}),
    page: boundedPositiveInteger(
      optionalScalarQuery(query, 'page'),
      'page',
      1,
      MAX_PAGE,
    ),
    pageSize: boundedPositiveInteger(
      optionalScalarQuery(query, 'pageSize'),
      'pageSize',
      20,
      MAX_PAGE_SIZE,
    ),
  };
}

function parseAdminRole(value: unknown, field = 'role'): AdminRole {
  if (value !== 'admin' && value !== 'user') {
    throw validationError(`${field} must be admin or user`, {
      field,
      allowed: ['admin', 'user'],
    });
  }
  return value;
}

function requireStoredRole(value: string): AdminRole {
  if (value !== 'admin' && value !== 'user') {
    throw new AppError(500, 'USER_ROLE_INVALID', 'A stored user role is invalid');
  }
  return value;
}

function parseCanonicalTimestamp(value: string, field: string): string {
  if (value.length > 64) {
    throw validationError(`${field} must be a canonical ISO timestamp`, { field });
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw validationError(`${field} must be a canonical ISO timestamp`, { field });
  }
  return value;
}

function auditCursorSignature(
  query: Omit<AuditQuery, 'cursor' | 'limit'>,
  occurredAt: string,
  id: string,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify({
      action: query.action ?? null,
      actorUserId: query.actorUserId ?? null,
      targetUserId: query.targetUserId ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      occurredAt,
      id,
    }))
    .digest('hex');
}

function signaturesEqual(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function decodeAuditCursor(
  value: string,
  filters: Omit<AuditQuery, 'cursor' | 'limit'>,
  secret: string,
): AuditCursor {
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw validationError('cursor is invalid', { field: 'cursor' });
  }

  let decoded: Record<string, unknown>;
  try {
    decoded = requireJsonObject(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    rejectUnknownKeys(decoded, ['v', 'occurredAt', 'id', 'filterHash']);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw validationError('cursor is invalid', { field: 'cursor' });
  }

  if (
    decoded.v !== 1 ||
    typeof decoded.occurredAt !== 'string' ||
    typeof decoded.id !== 'string' ||
    typeof decoded.filterHash !== 'string'
  ) {
    throw validationError('cursor is invalid', { field: 'cursor' });
  }
  const cursor: AuditCursor = {
    v: 1,
    occurredAt: parseCanonicalTimestamp(decoded.occurredAt, 'cursor'),
    id: normalizeStableId(decoded.id, 'cursor'),
    filterHash: decoded.filterHash,
  };
  const expectedSignature = auditCursorSignature(
    filters,
    cursor.occurredAt,
    cursor.id,
    secret,
  );
  if (!signaturesEqual(cursor.filterHash, expectedSignature)) {
    throw validationError('cursor is invalid or does not match the requested filters', {
      field: 'cursor',
    });
  }
  return cursor;
}

function encodeAuditCursor(
  row: AdminAuditRow,
  filters: Omit<AuditQuery, 'cursor' | 'limit'>,
  secret: string,
): string {
  const cursor: AuditCursor = {
    v: 1,
    occurredAt: row.occurred_at,
    id: row.id,
    filterHash: auditCursorSignature(filters, row.occurred_at, row.id, secret),
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function parseAuditQuery(rawQuery: V1AuthRequest['query'], cursorSecret: string): AuditQuery {
  const query = rawQuery as Record<string, unknown>;
  rejectUnknownKeys(query, AUDIT_QUERY_KEYS);

  const rawAction = optionalScalarQuery(query, 'action');
  if (
    rawAction !== undefined &&
    !ADMIN_AUDIT_ACTIONS.includes(rawAction as AdminAuditAction)
  ) {
    throw validationError('action is not a supported admin audit action', {
      field: 'action',
      allowed: ADMIN_AUDIT_ACTIONS,
    });
  }

  const rawActorUserId = optionalScalarQuery(query, 'actorUserId');
  const rawTargetUserId = optionalScalarQuery(query, 'targetUserId');
  const rawFrom = optionalScalarQuery(query, 'from');
  const rawTo = optionalScalarQuery(query, 'to');
  const filters: Omit<AuditQuery, 'cursor' | 'limit'> = {
    ...(rawAction ? { action: rawAction as AdminAuditAction } : {}),
    ...(rawActorUserId
      ? { actorUserId: normalizeStableId(rawActorUserId, 'actorUserId') }
      : {}),
    ...(rawTargetUserId
      ? { targetUserId: normalizeStableId(rawTargetUserId, 'targetUserId') }
      : {}),
    ...(rawFrom ? { from: parseCanonicalTimestamp(rawFrom, 'from') } : {}),
    ...(rawTo ? { to: parseCanonicalTimestamp(rawTo, 'to') } : {}),
  };
  if (filters.from && filters.to && filters.from >= filters.to) {
    throw validationError('from must be earlier than to', {
      fields: ['from', 'to'],
    });
  }

  const rawCursor = optionalScalarQuery(query, 'cursor');
  return {
    ...filters,
    limit: boundedPositiveInteger(
      optionalScalarQuery(query, 'limit'),
      'limit',
      DEFAULT_AUDIT_LIMIT,
      MAX_AUDIT_LIMIT,
    ),
    ...(rawCursor ? { cursor: decodeAuditCursor(rawCursor, filters, cursorSecret) } : {}),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function registrationEnabled(value: number): boolean {
  if (value !== 0 && value !== 1) {
    throw new AppError(
      500,
      'SERVER_SETTINGS_INVALID',
      'Server registration setting is invalid',
    );
  }
  return value === 1;
}

function settingsDto(row: SettingsRow) {
  return { registrationEnabled: registrationEnabled(row.registration_enabled) };
}

function userDto(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    role: requireStoredRole(row.role),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sendWriteResult(res: Response, result: WriteResult): void {
  if (result.replay) res.setHeader('Idempotent-Replay', 'true');
  res.status(result.status).json(result.body);
}

function insertAuditEvent(
  db: Database.Database,
  input: {
    action: AdminAuditAction;
    actorUserId: string;
    targetUserId?: string;
    requestId: string;
    mutationId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    details?: Record<string, unknown>;
    occurredAt: string;
  },
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO admin_audit_events (
      id, action, actor_user_id, target_user_id, request_id, mutation_id,
      before_json, after_json, details_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.action,
    input.actorUserId,
    input.targetUserId ?? null,
    input.requestId,
    input.mutationId,
    input.before ? JSON.stringify(input.before) : null,
    input.after ? JSON.stringify(input.after) : null,
    JSON.stringify(input.details ?? {}),
    input.occurredAt,
  );
  return id;
}

function parseAuditObject(value: string | null, field: string): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError(
      500,
      'ADMIN_AUDIT_INVALID',
      `Stored administrator audit ${field} is invalid`,
    );
  }
}

function requireEmptyCommandBody(req: V1AuthRequest): Record<string, unknown> {
  const rawLength = req.header('content-length');
  const contentLength = rawLength === undefined ? 0 : Number(rawLength);
  const hasDeclaredBody =
    (Number.isFinite(contentLength) && contentLength > 0) ||
    req.header('transfer-encoding') !== undefined;
  if (hasDeclaredBody && !req.is('application/json')) {
    throw new AppError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'A request body for this endpoint must use application/json',
    );
  }
  if (req.body !== undefined) return requireJsonObject(req.body);
  return {};
}

function requireSettingsRow(row: SettingsRow | undefined): SettingsRow {
  if (!row) {
    throw new AppError(500, 'SERVER_SETTINGS_MISSING', 'Server settings are not initialized');
  }
  return row;
}

function requireCurrentAdmin(db: Database.Database, req: V1AuthRequest): void {
  if (!req.auth) {
    throw new AppError(401, 'AUTH_REQUIRED', 'A Bearer access token is required');
  }
  const currentUser = db
    .prepare('SELECT role FROM users WHERE id = ?')
    .get(req.auth.userId) as CurrentUserRow | undefined;
  if (!currentUser) {
    throw new AppError(401, 'TOKEN_INVALID', 'Access token user no longer exists');
  }
  if (req.auth.role !== 'admin' || currentUser.role !== 'admin') {
    throw new AppError(
      403,
      'ADMIN_REQUIRED',
      'Server administrator privileges are required',
    );
  }
}

export function createAdminV1Router(dependencies: AdminV1Dependencies = {}): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const requireAccessToken = createAccessTokenMiddleware(runtimeConfig);

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(requireAccessToken);
  router.use((req: V1AuthRequest, _res, next) => {
    try {
      requireCurrentAdmin(database(), req);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get('/overview', (_req, res, next) => {
    try {
      const row = database().prepare(`
        SELECT
          ss.instance_id,
          ss.registration_enabled,
          (SELECT COUNT(*) FROM users) AS user_total,
          (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admin_total,
          (SELECT COUNT(*) FROM sessions) AS session_total,
          (
            SELECT COUNT(*) FROM sessions
            WHERE deleted_at IS NULL AND status = 'initializing'
          ) AS session_initializing,
          (
            SELECT COUNT(*) FROM sessions
            WHERE deleted_at IS NULL AND status = 'active'
          ) AS session_active,
          (
            SELECT COUNT(*) FROM sessions
            WHERE deleted_at IS NULL AND status = 'closed'
          ) AS session_closed,
          (
            SELECT COUNT(*) FROM sessions
            WHERE deleted_at IS NOT NULL
          ) AS session_deleted
        FROM server_settings ss
        WHERE ss.id = 1
      `).get() as OverviewRow | undefined;

      if (!row?.instance_id) {
        throw new AppError(500, 'SERVER_SETTINGS_MISSING', 'Server settings are not initialized');
      }
      res.json({
        serverInstanceId: row.instance_id,
        generatedAt: new Date().toISOString(),
        registrationEnabled: registrationEnabled(row.registration_enabled),
        counts: {
          users: {
            total: Number(row.user_total),
            admins: Number(row.admin_total),
          },
          sessions: {
            total: Number(row.session_total),
            initializing: Number(row.session_initializing),
            active: Number(row.session_active),
            closed: Number(row.session_closed),
            deleted: Number(row.session_deleted),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/settings', (_req, res, next) => {
    try {
      const row = database()
        .prepare('SELECT registration_enabled FROM server_settings WHERE id = 1')
        .get() as SettingsRow | undefined;
      res.json(settingsDto(requireSettingsRow(row)));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/settings', (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['registrationEnabled']);
      if (typeof body.registrationEnabled !== 'boolean') {
        throw validationError('registrationEnabled must be a boolean', {
          field: 'registrationEnabled',
        });
      }

      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash(req.method, req.baseUrl + req.path, body);
      const db = database();
      const updateSettings = db.transaction(() => {
        requireCurrentAdmin(db, req);
        const replay = readStoredResponse(
          db,
          mutationId,
          req.auth!.userId,
          requestHash,
        );
        if (replay) {
          return { ...replay, replay: true } satisfies WriteResult;
        }

        const previous = requireSettingsRow(
          db.prepare('SELECT registration_enabled FROM server_settings WHERE id = 1')
            .get() as SettingsRow | undefined,
        );
        const previousValue = registrationEnabled(previous.registration_enabled);
        if (previousValue !== body.registrationEnabled) {
          const update = db
            .prepare('UPDATE server_settings SET registration_enabled = ? WHERE id = 1')
            .run(body.registrationEnabled ? 1 : 0);
          if (update.changes !== 1) {
            throw new AppError(
              500,
              'SERVER_SETTINGS_MISSING',
              'Server settings are not initialized',
            );
          }
          insertAuditEvent(db, {
            action: 'settings.registration.updated',
            actorUserId: req.auth!.userId,
            requestId: getRequestId(req),
            mutationId,
            before: { registrationEnabled: previousValue },
            after: { registrationEnabled: body.registrationEnabled },
            occurredAt: new Date().toISOString(),
          });
        }

        const response = { registrationEnabled: body.registrationEnabled };
        storeResponse(db, {
          mutationId,
          userId: req.auth!.userId,
          requestHash,
          status: 200,
          body: response,
        });
        return { status: 200, body: response, replay: false } satisfies WriteResult;
      });
      sendWriteResult(res, updateSettings.immediate());
    } catch (error) {
      next(error);
    }
  });

  router.get('/users', (req: V1AuthRequest, res, next) => {
    try {
      const query = parseUsersQuery(req.query);
      const clauses: string[] = [];
      const parameters: string[] = [];
      if (query.q) {
        clauses.push("username LIKE ? ESCAPE '\\' COLLATE NOCASE");
        parameters.push(`%${escapeLike(query.q)}%`);
      }
      if (query.role) {
        clauses.push('role = ?');
        parameters.push(query.role);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const offset = (query.page - 1) * query.pageSize;
      const db = database();
      const readPage = db.transaction(() => {
        const count = db
          .prepare(`SELECT COUNT(*) AS total FROM users ${where}`)
          .get(...parameters) as { total: number };
        const rows = db.prepare(`
          SELECT id, username, role, created_at, updated_at
          FROM users
          ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `).all(...parameters, query.pageSize, offset) as UserRow[];
        return { total: Number(count.total), rows };
      });
      const result = readPage();
      res.json({
        items: result.rows.map((row) => ({
          id: row.id,
          username: row.username,
          role: row.role,
          createdAt: row.created_at,
        })),
        page: query.page,
        pageSize: query.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / query.pageSize),
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/users/:userId/role', (req: V1AuthRequest, res, next) => {
    try {
      const targetUserId = normalizeStableId(req.params.userId, 'userId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['role']);
      const requestedRole = parseAdminRole(body.role);
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash(req.method, req.baseUrl + req.path, body);
      const db = database();

      const changeRole = db.transaction(() => {
        requireCurrentAdmin(db, req);
        const replay = readStoredResponse(
          db,
          mutationId,
          req.auth!.userId,
          requestHash,
        );
        if (replay) return { ...replay, replay: true } satisfies WriteResult;

        const target = db.prepare(`
          SELECT id, username, role, created_at, updated_at
          FROM users
          WHERE id = ?
        `).get(targetUserId) as UserRow | undefined;
        if (!target) {
          throw new AppError(404, 'USER_NOT_FOUND', 'The requested user does not exist');
        }
        const previousRole = requireStoredRole(target.role);

        if (targetUserId === req.auth!.userId) {
          if (previousRole === 'admin' && requestedRole === 'user') {
            const row = db.prepare(
              "SELECT COUNT(*) AS count FROM users WHERE role = 'admin'",
            ).get() as { count: number };
            if (Number(row.count) <= 1) {
              throw new AppError(
                409,
                'LAST_ADMIN_REQUIRED',
                'The server must retain at least one administrator',
              );
            }
          }
          throw new AppError(
            409,
            'SELF_ROLE_CHANGE_FORBIDDEN',
            'Administrators cannot change their own role',
          );
        }

        if (previousRole === requestedRole) {
          const response = {
            user: userDto(target),
            changed: false,
            revokedRefreshTokenCount: 0,
            reauthenticationRequired: false,
            auditEventId: null,
          };
          storeResponse(db, {
            mutationId,
            userId: req.auth!.userId,
            requestHash,
            status: 200,
            body: response,
          });
          return { status: 200, body: response, replay: false } satisfies WriteResult;
        }

        if (previousRole === 'admin' && requestedRole === 'user') {
          const row = db.prepare(
            "SELECT COUNT(*) AS count FROM users WHERE role = 'admin'",
          ).get() as { count: number };
          if (Number(row.count) <= 1) {
            throw new AppError(
              409,
              'LAST_ADMIN_REQUIRED',
              'The server must retain at least one administrator',
            );
          }
        }

        const occurredAt = new Date().toISOString();
        const update = db.prepare(`
          UPDATE users
          SET role = ?, updated_at = ?
          WHERE id = ? AND role = ?
        `).run(requestedRole, occurredAt, targetUserId, previousRole);
        if (update.changes !== 1) {
          throw new AppError(409, 'USER_ROLE_CHANGED', 'The user role changed concurrently');
        }
        const revoked = db.prepare(`
          UPDATE refresh_tokens
          SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        `).run(occurredAt, targetUserId, occurredAt);
        const auditEventId = insertAuditEvent(db, {
          action: 'user.role.updated',
          actorUserId: req.auth!.userId,
          targetUserId,
          requestId: getRequestId(req),
          mutationId,
          before: { role: previousRole },
          after: { role: requestedRole },
          details: { revokedRefreshTokenCount: Number(revoked.changes) },
          occurredAt,
        });
        const updated = db.prepare(`
          SELECT id, username, role, created_at, updated_at
          FROM users
          WHERE id = ?
        `).get(targetUserId) as UserRow | undefined;
        if (!updated) {
          throw new AppError(500, 'USER_NOT_FOUND', 'The updated user could not be read');
        }
        const response = {
          user: userDto(updated),
          changed: true,
          revokedRefreshTokenCount: Number(revoked.changes),
          reauthenticationRequired: true,
          auditEventId,
        };
        storeResponse(db, {
          mutationId,
          userId: req.auth!.userId,
          requestHash,
          status: 200,
          body: response,
        });
        return { status: 200, body: response, replay: false } satisfies WriteResult;
      });

      sendWriteResult(res, changeRole.immediate());
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/users/:userId/revoke-refresh-tokens',
    (req: V1AuthRequest, res, next) => {
      try {
        const targetUserId = normalizeStableId(req.params.userId, 'userId');
        const body = requireEmptyCommandBody(req);
        rejectUnknownKeys(body, []);
        const mutationId = requireIdempotencyKey(req);
        const requestHash = computeRequestHash(req.method, req.baseUrl + req.path, body);
        const db = database();

        const revokeTokens = db.transaction(() => {
          requireCurrentAdmin(db, req);
          const replay = readStoredResponse(
            db,
            mutationId,
            req.auth!.userId,
            requestHash,
          );
          if (replay) return { ...replay, replay: true } satisfies WriteResult;

          const target = db.prepare('SELECT 1 FROM users WHERE id = ?')
            .get(targetUserId);
          if (!target) {
            throw new AppError(404, 'USER_NOT_FOUND', 'The requested user does not exist');
          }

          const processedAt = new Date().toISOString();
          const revoked = db.prepare(`
            UPDATE refresh_tokens
            SET revoked_at = ?
            WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
          `).run(processedAt, targetUserId, processedAt);
          const revokedRefreshTokenCount = Number(revoked.changes);
          const auditEventId = revokedRefreshTokenCount > 0
            ? insertAuditEvent(db, {
                action: 'user.refresh_tokens.revoked',
                actorUserId: req.auth!.userId,
                targetUserId,
                requestId: getRequestId(req),
                mutationId,
                details: { revokedRefreshTokenCount },
                occurredAt: processedAt,
              })
            : null;
          const response = {
            userId: targetUserId,
            revokedRefreshTokenCount,
            processedAt,
            accessTokensRemainValidUntilExpiry: true,
            auditEventId,
          };
          storeResponse(db, {
            mutationId,
            userId: req.auth!.userId,
            requestHash,
            status: 200,
            body: response,
          });
          return { status: 200, body: response, replay: false } satisfies WriteResult;
        });

        sendWriteResult(res, revokeTokens.immediate());
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/audit-events', (req: V1AuthRequest, res, next) => {
    try {
      const query = parseAuditQuery(req.query, runtimeConfig.jwtSecret);
      const clauses: string[] = [];
      const parameters: Array<string | number> = [];
      if (query.action) {
        clauses.push('action = ?');
        parameters.push(query.action);
      }
      if (query.actorUserId) {
        clauses.push('actor_user_id = ?');
        parameters.push(query.actorUserId);
      }
      if (query.targetUserId) {
        clauses.push('target_user_id = ?');
        parameters.push(query.targetUserId);
      }
      if (query.from) {
        clauses.push('occurred_at >= ?');
        parameters.push(query.from);
      }
      if (query.to) {
        clauses.push('occurred_at < ?');
        parameters.push(query.to);
      }
      if (query.cursor) {
        clauses.push('(occurred_at < ? OR (occurred_at = ? AND id < ?))');
        parameters.push(
          query.cursor.occurredAt,
          query.cursor.occurredAt,
          query.cursor.id,
        );
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = database().prepare(`
        SELECT
          id, action, actor_user_id, target_user_id, request_id, mutation_id,
          before_json, after_json, details_json, occurred_at
        FROM admin_audit_events
        ${where}
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?
      `).all(...parameters, query.limit + 1) as AdminAuditRow[];
      const hasMore = rows.length > query.limit;
      const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
      const filters: Omit<AuditQuery, 'cursor' | 'limit'> = {
        ...(query.action ? { action: query.action } : {}),
        ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
        ...(query.targetUserId ? { targetUserId: query.targetUserId } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
      };
      const lastRow = pageRows.at(-1);
      res.json({
        items: pageRows.map((row) => ({
          auditEventId: row.id,
          action: row.action,
          actorUserId: row.actor_user_id,
          targetUserId: row.target_user_id,
          before: parseAuditObject(row.before_json, 'before value'),
          after: parseAuditObject(row.after_json, 'after value'),
          details: parseAuditObject(row.details_json, 'details'),
          requestId: row.request_id,
          mutationId: row.mutation_id,
          occurredAt: row.occurred_at,
        })),
        pageInfo: {
          limit: query.limit,
          hasMore,
          nextCursor: hasMore && lastRow
            ? encodeAuditCursor(lastRow, filters, runtimeConfig.jwtSecret)
            : null,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminV1Router = createAdminV1Router();
