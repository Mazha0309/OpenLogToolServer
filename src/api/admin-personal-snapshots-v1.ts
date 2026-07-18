import Database from 'better-sqlite3';
import { Router } from 'express';
import { requireCurrentAdmin } from './admin-v1';
import { auditSensitiveUserRead } from './admin-governance-v1';
import { normalizeStableId } from '../collaboration/access';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { usernameIdentity } from '../auth/username-identity';
import {
  PersonalSnapshot,
  validatePersonalSnapshot,
} from '../personal-snapshot/model';
import { rejectUnknownKeys } from '../utils/validation';

interface AdminPersonalSnapshotsV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

interface PersonalSnapshotListQuery {
  q?: string;
  page: number;
  pageSize: number;
}

interface AdminPersonalSnapshotRow {
  user_id: string;
  username: string;
  revision: number;
  format_version: number;
  snapshot_json?: string;
  session_count: number;
  log_count: number;
  byte_size: number;
  checksum: string;
  created_at: string;
  updated_at: string;
}

const LIST_QUERY_KEYS = ['q', 'page', 'pageSize'] as const;
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

function parseListQuery(rawQuery: V1AuthRequest['query']): PersonalSnapshotListQuery {
  const query = rawQuery as Record<string, unknown>;
  rejectUnknownKeys(query, LIST_QUERY_KEYS);
  const rawSearch = optionalScalarQuery(query, 'q');
  const trimmedSearch = rawSearch?.trim();
  const search = trimmedSearch ? usernameIdentity(trimmedSearch) : undefined;
  if (search && search.length > 64) {
    throw validationError('q must be at most 64 characters', {
      field: 'q',
      max: 64,
    });
  }
  return {
    ...(search ? { q: search } : {}),
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

function userDto(row: AdminPersonalSnapshotRow) {
  return {
    id: row.user_id,
    username: row.username,
  };
}

function snapshotMetadata(row: AdminPersonalSnapshotRow) {
  return {
    exists: true as const,
    revision: Number(row.revision),
    formatVersion: Number(row.format_version),
    sessionCount: Number(row.session_count),
    logCount: Number(row.log_count),
    byteSize: Number(row.byte_size),
    checksum: row.checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshotNotFound(): AppError {
  return new AppError(
    404,
    'PERSONAL_SNAPSHOT_NOT_FOUND',
    'No personal cloud snapshot was found for the requested account',
  );
}

function corruptSnapshot(cause?: unknown): AppError {
  return new AppError(
    500,
    'PERSONAL_SNAPSHOT_CORRUPT',
    'The stored personal cloud snapshot failed integrity validation',
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

function validatedStoredSnapshot(row: AdminPersonalSnapshotRow): PersonalSnapshot {
  if (row.snapshot_json === undefined) throw corruptSnapshot();
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.snapshot_json) as unknown;
  } catch (error) {
    throw corruptSnapshot(error);
  }

  try {
    const validated = validatePersonalSnapshot(parsed);
    if (
      validated.snapshot.version !== Number(row.format_version) ||
      validated.sessionCount !== Number(row.session_count) ||
      validated.logCount !== Number(row.log_count) ||
      validated.byteSize !== Number(row.byte_size) ||
      validated.checksum !== row.checksum
    ) {
      throw corruptSnapshot();
    }
    return validated.snapshot;
  } catch (error) {
    if (error instanceof AppError && error.code === 'PERSONAL_SNAPSHOT_CORRUPT') {
      throw error;
    }
    throw corruptSnapshot(error);
  }
}

export function createAdminPersonalSnapshotsV1Router(
  dependencies: AdminPersonalSnapshotsV1Dependencies = {},
): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(createAccessTokenMiddleware(runtimeConfig, database));
  router.use((req: V1AuthRequest, _res, next) => {
    try {
      requireCurrentAdmin(database(), req);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get('/personal-snapshots', (req: V1AuthRequest, res, next) => {
    try {
      const query = parseListQuery(req.query);
      const parameters: string[] = [];
      const where = query.q
        ? "WHERE username_identity(u.username) LIKE ? ESCAPE '\\'"
        : '';
      if (query.q) parameters.push(`%${escapeLike(query.q)}%`);
      const offset = (query.page - 1) * query.pageSize;
      const db = database();
      const readPage = db.transaction(() => {
        const count = db.prepare(`
          SELECT COUNT(*) AS total
          FROM personal_cloud_snapshots p
          INNER JOIN users u ON u.id = p.user_id
          ${where}
        `).get(...parameters) as { total: number };
        const rows = db.prepare(`
          SELECT
            p.user_id, u.username, p.revision, p.format_version,
            p.session_count, p.log_count, p.byte_size,
            p.checksum, p.created_at, p.updated_at
          FROM personal_cloud_snapshots p
          INNER JOIN users u ON u.id = p.user_id
          ${where}
          ORDER BY p.updated_at DESC, p.user_id DESC
          LIMIT ? OFFSET ?
        `).all(...parameters, query.pageSize, offset) as AdminPersonalSnapshotRow[];
        return { total: Number(count.total), rows };
      });
      const result = readPage();
      res.json({
        items: result.rows.map((row) => ({
          user: userDto(row),
          personalSnapshot: snapshotMetadata(row),
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

  router.get('/personal-snapshots/:userId', (req: V1AuthRequest, res, next) => {
    try {
      const userId = normalizeStableId(req.params.userId, 'userId');
      const row = database().prepare(`
        SELECT
          p.user_id, u.username, p.revision, p.format_version,
          p.snapshot_json, p.session_count, p.log_count, p.byte_size,
          p.checksum, p.created_at, p.updated_at
        FROM personal_cloud_snapshots p
        INNER JOIN users u ON u.id = p.user_id
        WHERE p.user_id = ?
      `).get(userId) as AdminPersonalSnapshotRow | undefined;
      if (!row) throw snapshotNotFound();
      const snapshot = validatedStoredSnapshot(row);
      auditSensitiveUserRead(
        database(),
        req,
        userId,
        'personal_snapshot.detail.viewed',
      );
      res.json({
        user: userDto(row),
        personalSnapshot: {
          ...snapshotMetadata(row),
          snapshot,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
