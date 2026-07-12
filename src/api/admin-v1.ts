import Database from 'better-sqlite3';
import { Router } from 'express';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
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
}

interface UsersQuery {
  q?: string;
  role?: 'admin' | 'user';
  page: number;
  pageSize: number;
}

const USERS_QUERY_KEYS = ['q', 'role', 'page', 'pageSize'] as const;
const MAX_PAGE = 1_000_000;
const MAX_PAGE_SIZE = 100;

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

      const db = database();
      const updateSettings = db.transaction(() => {
        // Recheck inside the write transaction so a future role-management path
        // cannot demote the actor between the router guard and this update.
        requireCurrentAdmin(db, req);
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
        const row = db
          .prepare('SELECT registration_enabled FROM server_settings WHERE id = 1')
          .get() as SettingsRow | undefined;
        return requireSettingsRow(row);
      });
      res.json(settingsDto(updateSettings.immediate()));
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
          SELECT id, username, role, created_at
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

  return router;
}

export const adminV1Router = createAdminV1Router();
