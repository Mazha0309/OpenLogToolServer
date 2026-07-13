import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { AppConfig } from '../config';
import { AppError } from '../errors/app-error';
import { V1AuthRequest } from '../middleware/auth-v1';

export const ADMIN_ELEVATION_AUDIENCE = 'openlogtool-admin-elevation-v1';
export const ADMIN_ELEVATION_TTL_SECONDS = 5 * 60;

export interface AdminElevationUser {
  id: string;
  auth_version: number;
}

export interface ActiveAdminAccess extends AdminElevationUser {
  password_hash: string;
}

interface ElevationClaims extends JwtPayload {
  type: 'admin-elevation';
  sub: string;
  authVersion: number;
}

export function issueAdminElevation(
  config: AppConfig,
  user: AdminElevationUser,
): string {
  return jwt.sign(
    { type: 'admin-elevation', authVersion: Number(user.auth_version) },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      issuer: config.jwtIssuer,
      audience: ADMIN_ELEVATION_AUDIENCE,
      subject: user.id,
      jwtid: randomUUID(),
      expiresIn: ADMIN_ELEVATION_TTL_SECONDS,
    },
  );
}

export function requireActiveAdminAccess(
  db: Database.Database,
  req: V1AuthRequest,
): ActiveAdminAccess {
  const identity = req.auth;
  if (!identity) {
    throw new AppError(401, 'AUTH_REQUIRED', 'A Bearer access token is required');
  }
  if (identity.expiresAtEpochSeconds <= Math.floor(Date.now() / 1000)) {
    throw new AppError(401, 'TOKEN_EXPIRED', 'Access token has expired');
  }
  const current = db.prepare(`
    SELECT id, password_hash, role, auth_version, disabled_at, deleted_at,
           must_change_password
    FROM users WHERE id = ?
  `).get(identity.userId) as {
    id: string;
    password_hash: string;
    role: string;
    auth_version: number;
    disabled_at: string | null;
    deleted_at: string | null;
    must_change_password: number;
  } | undefined;
  if (!current || current.deleted_at) {
    throw new AppError(401, 'TOKEN_REVOKED', 'Administrator account no longer exists');
  }
  if (current.role !== 'admin') {
    throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
  }
  if (current.disabled_at) {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
  }
  if (Number(current.must_change_password) === 1) {
    throw new AppError(
      403,
      'PASSWORD_CHANGE_REQUIRED',
      'The temporary password must be changed before continuing',
    );
  }
  const currentAuthVersion = Number(current.auth_version);
  if (
    (identity.authVersion === undefined && currentAuthVersion !== 1) ||
    (identity.authVersion !== undefined && identity.authVersion !== currentAuthVersion)
  ) {
    throw new AppError(401, 'TOKEN_REVOKED', 'Access token has been revoked');
  }
  if (identity.authSessionId) {
    const activeSession = db.prepare(`
      SELECT 1 FROM refresh_tokens
      WHERE user_id = ?
        AND (auth_session_id = ? OR (auth_session_id IS NULL AND id = ?))
        AND revoked_at IS NULL AND expires_at > ?
    `).get(
      identity.userId,
      identity.authSessionId,
      identity.authSessionId,
      new Date().toISOString(),
    );
    if (!activeSession) {
      throw new AppError(401, 'TOKEN_REVOKED', 'The device session has been revoked');
    }
  }
  return {
    id: current.id,
    password_hash: current.password_hash,
    auth_version: currentAuthVersion,
  };
}

export function requireAdminElevation(
  db: Database.Database,
  config: AppConfig,
  req: V1AuthRequest,
): void {
  const token = req.header('x-admin-elevation');
  if (!token) {
    throw new AppError(403, 'ADMIN_ELEVATION_REQUIRED', 'Re-authenticate before this operation');
  }
  let payload: string | JwtPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: config.jwtIssuer,
      audience: ADMIN_ELEVATION_AUDIENCE,
    });
  } catch {
    throw new AppError(
      403,
      'ADMIN_ELEVATION_INVALID',
      'Administrator elevation expired or invalid',
    );
  }
  if (
    typeof payload === 'string' ||
    payload.type !== 'admin-elevation' ||
    payload.sub !== req.auth?.userId ||
    !Number.isSafeInteger(payload.authVersion)
  ) {
    throw new AppError(403, 'ADMIN_ELEVATION_INVALID', 'Administrator elevation is invalid');
  }
  const current = requireActiveAdminAccess(db, req);
  if (Number(current.auth_version) !== Number((payload as ElevationClaims).authVersion)) {
    throw new AppError(403, 'ADMIN_ELEVATION_INVALID', 'Administrator credentials changed');
  }
}
