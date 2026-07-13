import { Request, RequestHandler } from 'express';
import Database from 'better-sqlite3';
import jwt, { JwtPayload, TokenExpiredError } from 'jsonwebtoken';
import { AppConfig, config } from '../config';
import { AppError } from '../errors/app-error';

export interface AccessIdentity {
  userId: string;
  role: string;
  tokenId: string;
  authVersion?: number;
  authSessionId?: string;
  expiresAtEpochSeconds: number;
}

export interface V1AuthRequest extends Request {
  auth?: AccessIdentity;
}

function identityFromPayload(payload: string | JwtPayload): AccessIdentity {
  if (
    typeof payload === 'string' ||
    payload.type !== 'access' ||
    typeof payload.sub !== 'string' ||
    typeof payload.role !== 'string' ||
    typeof payload.jti !== 'string' ||
    !Number.isSafeInteger(payload.exp)
  ) {
    throw new AppError(401, 'TOKEN_INVALID', 'Access token is invalid');
  }
  if (
    payload.av !== undefined &&
    (!Number.isSafeInteger(payload.av) || Number(payload.av) < 1)
  ) {
    throw new AppError(401, 'TOKEN_INVALID', 'Access token is invalid');
  }
  if (payload.sid !== undefined && typeof payload.sid !== 'string') {
    throw new AppError(401, 'TOKEN_INVALID', 'Access token is invalid');
  }
  return {
    userId: payload.sub,
    role: payload.role,
    tokenId: payload.jti,
    expiresAtEpochSeconds: Number(payload.exp),
    ...(payload.av === undefined ? {} : { authVersion: Number(payload.av) }),
    ...(payload.sid === undefined ? {} : { authSessionId: payload.sid }),
  };
}

type DatabaseSource = Database.Database | (() => Database.Database);

interface AccountStateRow {
  role: string;
  disabled_at: string | null;
  deleted_at: string | null;
  must_change_password: number;
  auth_version: number;
}

function resolveDatabase(req: Request, source?: DatabaseSource): Database.Database | undefined {
  if (typeof source === 'function') return source();
  if (source) return source;
  return (req.app.locals.openLogTool as { db?: Database.Database } | undefined)?.db;
}

export function createAccessTokenMiddleware(
  runtimeConfig: AppConfig,
  databaseSource?: DatabaseSource,
): RequestHandler {
  return (req: V1AuthRequest, _res, next) => {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      next(new AppError(401, 'AUTH_REQUIRED', 'A Bearer access token is required'));
      return;
    }
    try {
      const payload = jwt.verify(header.slice(7), runtimeConfig.jwtSecret, {
        algorithms: ['HS256'],
        issuer: runtimeConfig.jwtIssuer,
        audience: 'openlogtool-v1',
      });
      const identity = identityFromPayload(payload);
      const database = resolveDatabase(req, databaseSource);
      if (database) {
        const current = database.prepare(`
          SELECT role, disabled_at, deleted_at, must_change_password, auth_version
          FROM users
          WHERE id = ?
        `).get(identity.userId) as AccountStateRow | undefined;
        if (!current || current.deleted_at) {
          throw new AppError(401, 'TOKEN_INVALID', 'Access token user no longer exists');
        }
        if (current.disabled_at) {
          throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled', {
            disabledAt: current.disabled_at,
          });
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
          const activeSession = database.prepare(`
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
        identity.role = current.role;
      }
      req.auth = identity;
      next();
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else if (error instanceof TokenExpiredError) {
        next(new AppError(401, 'TOKEN_EXPIRED', 'Access token has expired'));
      } else {
        next(new AppError(401, 'TOKEN_INVALID', 'Access token is invalid'));
      }
    }
  };
}

export const requireAccessToken = createAccessTokenMiddleware(config);
