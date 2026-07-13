import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { Router } from 'express';
import {
  findAuthUserById,
  toPublicUser,
  validatePassword,
  validateUsername,
} from '../auth/service';
import { normalizeStableId } from '../collaboration/access';
import { getRealtimeHub } from '../collaboration/realtime';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';

interface AccountV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

interface DeviceSessionRow {
  id: string;
  device_id: string | null;
  auth_session_id: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  user_agent: string | null;
  ip_address: string | null;
}

function accountDto(user: NonNullable<ReturnType<typeof findAuthUserById>>) {
  return {
    ...toPublicUser(user),
    mustChangePassword: Number(user.must_change_password) === 1,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    passwordChangedAt: user.password_changed_at,
    usernameChangedAt: user.username_changed_at,
  };
}

function requireCurrentPassword(password: string, hash: string): void {
  if (!bcrypt.compareSync(password, hash)) {
    throw new AppError(403, 'CURRENT_PASSWORD_INCORRECT', 'The current password is incorrect');
  }
}

function updateOwnUsername(
  db: Database.Database,
  userId: string,
  username: string,
  currentPassword?: string,
) {
  return db.transaction(() => {
    const user = findAuthUserById(db, userId);
    if (!user || user.deleted_at) {
      throw new AppError(401, 'TOKEN_INVALID', 'Access token user no longer exists');
    }
    if (currentPassword !== undefined) {
      requireCurrentPassword(currentPassword, user.password_hash);
    }
    if (username === user.username) return user;
    const conflict = db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').get(
      username,
      user.id,
    );
    if (conflict) throw new AppError(409, 'USERNAME_TAKEN', 'Username is already registered');
    const now = new Date().toISOString();
    try {
      const result = db.prepare(`
        UPDATE users
        SET username = ?, username_changed_at = ?, updated_at = ?
        WHERE id = ? AND username = ? AND disabled_at IS NULL AND deleted_at IS NULL
      `).run(username, now, now, user.id, user.username);
      if (result.changes !== 1) {
        throw new AppError(409, 'ACCOUNT_CHANGED', 'The account changed concurrently');
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      if (code.startsWith('SQLITE_CONSTRAINT')) {
        throw new AppError(409, 'USERNAME_TAKEN', 'Username is already registered');
      }
      throw error;
    }
    return findAuthUserById(db, user.id)!;
  }).immediate();
}

function changeOwnPassword(
  db: Database.Database,
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  return db.transaction(() => {
    const user = findAuthUserById(db, userId);
    if (!user || user.deleted_at) {
      throw new AppError(401, 'TOKEN_INVALID', 'Access token user no longer exists');
    }
    requireCurrentPassword(currentPassword, user.password_hash);
    if (bcrypt.compareSync(newPassword, user.password_hash)) {
      throw new AppError(409, 'PASSWORD_UNCHANGED', 'The new password must be different');
    }
    const changedAt = new Date().toISOString();
    const update = db.prepare(`
      UPDATE users
      SET password_hash = ?, must_change_password = 0,
          auth_version = auth_version + 1,
          password_changed_at = ?, updated_at = ?
      WHERE id = ? AND auth_version = ?
        AND disabled_at IS NULL AND deleted_at IS NULL
    `).run(
      bcrypt.hashSync(newPassword, 10),
      changedAt,
      changedAt,
      user.id,
      user.auth_version,
    );
    if (update.changes !== 1) {
      throw new AppError(409, 'ACCOUNT_CHANGED', 'The account changed concurrently');
    }
    const revoked = db.prepare(`
      UPDATE refresh_tokens
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    `).run(changedAt, user.id, changedAt);
    return {
      passwordChangedAt: changedAt,
      revokedDeviceSessionCount: Number(revoked.changes),
      reauthenticationRequired: true,
    };
  }).immediate();
}

function readDeviceSessions(db: Database.Database, userId: string) {
  const now = new Date().toISOString();
  return db.prepare(`
    WITH family_created AS (
      SELECT auth_session_id, MIN(created_at) AS created_at
      FROM refresh_tokens
      WHERE user_id = ?
      GROUP BY auth_session_id
    )
    SELECT
      active.auth_session_id AS id,
      active.device_id,
      active.auth_session_id,
      family_created.created_at,
      active.expires_at,
      active.last_used_at,
      active.user_agent,
      active.ip_address
    FROM refresh_tokens active
    JOIN family_created
      ON family_created.auth_session_id = active.auth_session_id
    WHERE active.user_id = ?
      AND active.revoked_at IS NULL
      AND active.expires_at > ?
      AND active.id = (
        SELECT newest.id
        FROM refresh_tokens newest
        WHERE newest.user_id = active.user_id
          AND newest.auth_session_id = active.auth_session_id
          AND newest.revoked_at IS NULL
          AND newest.expires_at > ?
        ORDER BY COALESCE(newest.last_used_at, newest.created_at) DESC, newest.id DESC
        LIMIT 1
      )
    ORDER BY COALESCE(active.last_used_at, active.created_at) DESC, active.id DESC
  `).all(userId, userId, now, now) as DeviceSessionRow[];
}

function revokeOwnDeviceSession(
  db: Database.Database,
  userId: string,
  sessionId: string,
): { authSessionId: string } {
  const now = new Date().toISOString();
  const row = db.prepare(`
    SELECT auth_session_id
    FROM refresh_tokens
    WHERE user_id = ? AND (auth_session_id = ? OR id = ?)
    ORDER BY CASE WHEN auth_session_id = ? THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `).get(userId, sessionId, sessionId, sessionId) as {
    auth_session_id: string | null;
  } | undefined;
  if (!row) {
    throw new AppError(404, 'DEVICE_SESSION_NOT_FOUND', 'Device session not found');
  }
  const authSessionId = row.auth_session_id ?? sessionId;
  const revoked = row.auth_session_id
    ? db.prepare(`
      UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?)
      WHERE user_id = ? AND auth_session_id = ?
        AND revoked_at IS NULL AND expires_at > ?
    `).run(now, userId, authSessionId, now)
    : db.prepare(`
      UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?)
      WHERE id = ? AND user_id = ?
        AND revoked_at IS NULL AND expires_at > ?
    `).run(now, sessionId, userId, now);
  if (revoked.changes < 1) {
    throw new AppError(404, 'DEVICE_SESSION_NOT_FOUND', 'Device session not found');
  }
  return { authSessionId };
}

function revokeDeviceRealtime(
  db: Database.Database,
  userId: string,
  identity: { authSessionId: string },
): void {
  getRealtimeHub(db).revokeAuthSession(userId, identity.authSessionId);
}

export function createAccountV1Router(dependencies: AccountV1Dependencies = {}): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(createAccessTokenMiddleware(runtimeConfig, database));

  router.get('/', (req: V1AuthRequest, res, next) => {
    try {
      const user = findAuthUserById(database(), req.auth!.userId);
      if (!user) throw new AppError(401, 'TOKEN_INVALID', 'Access token user no longer exists');
      res.json(accountDto(user));
    } catch (error) {
      next(error);
    }
  });

  // Web-management compatibility surface. It deliberately enforces the same
  // current-password proof as the canonical /username endpoint.
  router.patch('/', (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['username', 'currentPassword']);
      const username = validateUsername(
        requireString(body, 'username', { min: 3, max: 64 }),
      );
      const currentPassword = requireString(
        body,
        'currentPassword',
        { min: 1, max: 4_096, trim: false },
      );
      const user = updateOwnUsername(
        database(),
        req.auth!.userId,
        username,
        currentPassword,
      );
      res.json({ user: accountDto(user) });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/username', (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['username', 'currentPassword']);
      const username = validateUsername(
        requireString(body, 'username', { min: 3, max: 64 }),
      );
      const currentPassword = requireString(
        body,
        'currentPassword',
        { min: 1, max: 4_096, trim: false },
      );
      const updated = updateOwnUsername(
        database(),
        req.auth!.userId,
        username,
        currentPassword,
      );
      res.json(accountDto(updated));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/password', (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['currentPassword', 'newPassword']);
      const currentPassword = requireString(
        body,
        'currentPassword',
        { min: 1, max: 4_096, trim: false },
      );
      const newPassword = validatePassword(
        requireString(body, 'newPassword', { min: 10, max: 128, trim: false }),
        'newPassword',
      );
      const result = changeOwnPassword(
        database(),
        req.auth!.userId,
        currentPassword,
        newPassword,
      );
      getRealtimeHub(database()).revokeUser(req.auth!.userId, 'PASSWORD_CHANGED');
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/change-password', (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['currentPassword', 'newPassword']);
      const currentPassword = requireString(
        body,
        'currentPassword',
        { min: 1, max: 4_096, trim: false },
      );
      const newPassword = validatePassword(
        requireString(body, 'newPassword', { min: 10, max: 128, trim: false }),
        'newPassword',
      );
      changeOwnPassword(database(), req.auth!.userId, currentPassword, newPassword);
      getRealtimeHub(database()).revokeUser(req.auth!.userId, 'PASSWORD_CHANGED');
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions', (req: V1AuthRequest, res, next) => {
    try {
      const rows = readDeviceSessions(database(), req.auth!.userId);
      res.json({
        items: rows.map((row) => ({
          sessionId: row.id,
          deviceId: row.device_id,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastUsedAt: row.last_used_at,
          userAgent: row.user_agent,
          ipAddress: row.ip_address,
          current: row.auth_session_id === req.auth!.authSessionId,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/devices', (req: V1AuthRequest, res, next) => {
    try {
      const rows = readDeviceSessions(database(), req.auth!.userId);
      res.json({
        items: rows.map((row) => ({
          id: row.id,
          deviceId: row.device_id,
          userAgent: row.user_agent,
          lastUsedAt: row.last_used_at,
          expiresAt: row.expires_at,
          current: row.auth_session_id === req.auth!.authSessionId,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/sessions/:sessionId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const db = database();
      const identity = revokeOwnDeviceSession(
        db,
        req.auth!.userId,
        sessionId,
      );
      revokeDeviceRealtime(db, req.auth!.userId, identity);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.delete('/devices/:deviceId', (req: V1AuthRequest, res, next) => {
    try {
      const deviceId = normalizeStableId(req.params.deviceId, 'deviceId');
      const db = database();
      const identity = revokeOwnDeviceSession(
        db,
        req.auth!.userId,
        deviceId,
      );
      revokeDeviceRealtime(db, req.auth!.userId, identity);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const accountV1Router = createAccountV1Router();
