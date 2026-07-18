import Database from 'better-sqlite3';
import { Router } from 'express';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import {
  PERSONAL_DICTIONARY_SNAPSHOT_FORMAT_VERSION,
  PERSONAL_DICTIONARY_SNAPSHOT_REPLACE_CONFIRMATION,
  PersonalDictionarySnapshot,
  validatePersonalDictionarySnapshot,
} from '../personal-dictionary-snapshot/model';
import { rejectUnknownKeys, requireJsonObject } from '../utils/validation';

interface PersonalDictionarySnapshotV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

interface PersonalDictionarySnapshotRow {
  user_id: string;
  revision: number;
  format_version: number;
  snapshot_json: string;
  item_count: number;
  active_count: number;
  deleted_count: number;
  byte_size: number;
  checksum: string;
  created_at: string;
  updated_at: string;
}

const PUT_KEYS = ['expectedRevision', 'confirmation', 'snapshot'] as const;
const REPLACE_RATE_LIMIT = 12;

function readSnapshotRow(
  db: Database.Database,
  userId: string,
): PersonalDictionarySnapshotRow | undefined {
  return db.prepare(`
    SELECT *
    FROM personal_dictionary_snapshots
    WHERE user_id = ?
  `).get(userId) as PersonalDictionarySnapshotRow | undefined;
}

function snapshotMetadata(row?: PersonalDictionarySnapshotRow) {
  if (!row) {
    return {
      exists: false,
      revision: 0,
      formatVersion: PERSONAL_DICTIONARY_SNAPSHOT_FORMAT_VERSION,
      itemCount: 0,
      activeCount: 0,
      deletedCount: 0,
      byteSize: 0,
      checksum: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    exists: true,
    revision: Number(row.revision),
    formatVersion: Number(row.format_version),
    itemCount: Number(row.item_count),
    activeCount: Number(row.active_count),
    deletedCount: Number(row.deleted_count),
    byteSize: Number(row.byte_size),
    checksum: row.checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function setRevisionEtag(res: { setHeader(name: string, value: string): void }, revision: number) {
  res.setHeader('ETag', `"${revision}"`);
}

function parseRevisionValue(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a non-negative integer`, {
      field,
    });
  }
  return Number(value);
}

function parseIfMatch(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^"(0|[1-9]\d*)"$/.exec(value.trim());
  if (!match) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      'If-Match must contain exactly one quoted dictionary snapshot revision',
      { field: 'If-Match', example: '"0"' },
    );
  }
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'If-Match revision is outside the allowed range', {
      field: 'If-Match',
    });
  }
  return revision;
}

function expectedRevision(req: V1AuthRequest, body: Record<string, unknown>): number {
  const bodyRevision = parseRevisionValue(body.expectedRevision, 'expectedRevision');
  const headerRevision = parseIfMatch(req.header('if-match'));
  if (bodyRevision === undefined && headerRevision === undefined) {
    throw new AppError(
      428,
      'PERSONAL_DICTIONARY_SNAPSHOT_REVISION_REQUIRED',
      'expectedRevision or If-Match is required for a destructive dictionary snapshot replacement',
    );
  }
  if (
    bodyRevision !== undefined &&
    headerRevision !== undefined &&
    bodyRevision !== headerRevision
  ) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      'expectedRevision and If-Match must identify the same revision',
      { expectedRevision: bodyRevision, ifMatchRevision: headerRevision },
    );
  }
  return bodyRevision ?? headerRevision!;
}

function requireReplaceConfirmation(body: Record<string, unknown>): void {
  if (body.confirmation !== PERSONAL_DICTIONARY_SNAPSHOT_REPLACE_CONFIRMATION) {
    throw new AppError(
      422,
      'PERSONAL_DICTIONARY_SNAPSHOT_REPLACE_CONFIRMATION_REQUIRED',
      'Explicit confirmation is required to replace the personal dictionary snapshot',
      { requiredConfirmation: PERSONAL_DICTIONARY_SNAPSHOT_REPLACE_CONFIRMATION },
    );
  }
}

function conflict(
  current: PersonalDictionarySnapshotRow | undefined,
  expected: number,
): AppError {
  return new AppError(
    409,
    'PERSONAL_DICTIONARY_SNAPSHOT_REVISION_CONFLICT',
    'The personal dictionary snapshot changed concurrently',
    {
      expectedRevision: expected,
      currentRevision: current?.revision ?? 0,
      currentChecksum: current?.checksum ?? null,
      updatedAt: current?.updated_at ?? null,
    },
  );
}

function corruptSnapshot(cause?: unknown): AppError {
  return new AppError(
    500,
    'PERSONAL_DICTIONARY_SNAPSHOT_CORRUPT',
    'The stored personal dictionary snapshot failed integrity validation',
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

function validatedStoredSnapshot(
  row: PersonalDictionarySnapshotRow,
): PersonalDictionarySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.snapshot_json) as unknown;
  } catch (error) {
    throw corruptSnapshot(error);
  }
  try {
    const validated = validatePersonalDictionarySnapshot(parsed);
    if (
      validated.snapshot.version !== Number(row.format_version) ||
      validated.itemCount !== Number(row.item_count) ||
      validated.activeCount !== Number(row.active_count) ||
      validated.deletedCount !== Number(row.deleted_count) ||
      validated.byteSize !== Number(row.byte_size) ||
      validated.checksum !== row.checksum
    ) {
      throw corruptSnapshot();
    }
    return validated.snapshot;
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === 'PERSONAL_DICTIONARY_SNAPSHOT_CORRUPT'
    ) {
      throw error;
    }
    throw corruptSnapshot(error);
  }
}

function replaceSnapshot(
  db: Database.Database,
  userId: string,
  expected: number,
  validated: ReturnType<typeof validatePersonalDictionarySnapshot>,
): { row: PersonalDictionarySnapshotRow; replaced: boolean } {
  return db.transaction(() => {
    const current = readSnapshotRow(db, userId);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expected) throw conflict(current, expected);
    if (current?.checksum === validated.checksum) {
      return { row: current, replaced: false };
    }

    const now = new Date().toISOString();
    if (!current) {
      db.prepare(`
        INSERT INTO personal_dictionary_snapshots (
          user_id, revision, format_version, snapshot_json,
          item_count, active_count, deleted_count,
          byte_size, checksum, created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        validated.snapshot.version,
        validated.serialized,
        validated.itemCount,
        validated.activeCount,
        validated.deletedCount,
        validated.byteSize,
        validated.checksum,
        now,
        now,
      );
    } else {
      const result = db.prepare(`
        UPDATE personal_dictionary_snapshots
        SET revision = revision + 1,
            format_version = ?, snapshot_json = ?, item_count = ?,
            active_count = ?, deleted_count = ?, byte_size = ?,
            checksum = ?, updated_at = ?
        WHERE user_id = ? AND revision = ?
      `).run(
        validated.snapshot.version,
        validated.serialized,
        validated.itemCount,
        validated.activeCount,
        validated.deletedCount,
        validated.byteSize,
        validated.checksum,
        now,
        userId,
        expected,
      );
      if (result.changes !== 1) throw conflict(readSnapshotRow(db, userId), expected);
    }
    const saved = readSnapshotRow(db, userId);
    if (!saved) {
      throw new AppError(
        500,
        'PERSONAL_DICTIONARY_SNAPSHOT_WRITE_FAILED',
        'Dictionary snapshot write did not persist',
      );
    }
    return { row: saved, replaced: true };
  }).immediate();
}

export function createPersonalDictionarySnapshotV1Router(
  dependencies: PersonalDictionarySnapshotV1Dependencies = {},
): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const replaceLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: REPLACE_RATE_LIMIT,
    maxKeys: 20_000,
    keyGenerator: (req) => {
      const auth = (req as V1AuthRequest).auth;
      return `${auth?.userId ?? 'anonymous'}:${req.ip}`;
    },
    message: 'Too many personal dictionary snapshot replacements; retry later',
  });
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(createAccessTokenMiddleware(runtimeConfig, database));

  router.get('/personal-dictionary-snapshot', (req: V1AuthRequest, res, next) => {
    try {
      const row = readSnapshotRow(database(), req.auth!.userId);
      setRevisionEtag(res, row?.revision ?? 0);
      res.json({ personalDictionarySnapshot: snapshotMetadata(row) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/personal-dictionary-snapshot/download', (req: V1AuthRequest, res, next) => {
    try {
      const row = readSnapshotRow(database(), req.auth!.userId);
      if (!row) {
        throw new AppError(
          404,
          'PERSONAL_DICTIONARY_SNAPSHOT_NOT_FOUND',
          'No personal dictionary snapshot has been uploaded for this account',
        );
      }
      const snapshot = validatedStoredSnapshot(row);
      setRevisionEtag(res, row.revision);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="openlogtool-personal-dictionaries-r${row.revision}.json"`,
      );
      res.json({
        personalDictionarySnapshot: {
          ...snapshotMetadata(row),
          snapshot,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    '/personal-dictionary-snapshot',
    ...(runtimeConfig.rateLimitEnabled ? [replaceLimiter] : []),
    (req: V1AuthRequest, res, next) => {
      try {
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, PUT_KEYS);
        const expected = expectedRevision(req, body);
        requireReplaceConfirmation(body);
        const validated = validatePersonalDictionarySnapshot(body.snapshot);
        const result = replaceSnapshot(database(), req.auth!.userId, expected, validated);
        setRevisionEtag(res, result.row.revision);
        res.json({
          replaced: result.replaced,
          personalDictionarySnapshot: snapshotMetadata(result.row),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
