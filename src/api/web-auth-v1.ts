import { timingSafeEqual } from 'crypto';
import Database from 'better-sqlite3';
import { Request, Response, Router } from 'express';
import {
  completeRequiredPasswordChange,
  createAccount,
  findAuthUserById,
  findRefreshTokenIdentity,
  issueTokens,
  IssuedAuthTokens,
  requireInteractiveLoginAllowed,
  RefreshTokenReuseError,
  revokeRefreshToken,
  rotateRefreshToken,
  toPublicUser,
  validatePassword,
  validateUsername,
  verifyCredentials,
} from '../auth/service';
import { getRealtimeHub } from '../collaboration/realtime';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import {
  optionalUuid,
  rejectUnknownKeys,
  requireJsonObject,
  requireString,
} from '../utils/validation';

interface WebAuthV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

export const WEB_REFRESH_COOKIE = 'olt_web_refresh';
const WEB_REFRESH_COOKIE_PATH = '/api/v1/web-auth';

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function credentials(body: unknown): { username: string; password: string; deviceId?: string } {
  const value = requireJsonObject(body);
  rejectUnknownKeys(value, ['username', 'password', 'deviceId']);
  return {
    username: validateUsername(requireString(value, 'username', { min: 3, max: 64 })),
    password: validatePassword(
      requireString(value, 'password', { min: 10, max: 128, trim: false }),
    ),
    deviceId: optionalUuid(value, 'deviceId'),
  };
}

function loginCredentials(body: unknown): { username: string; password: string; deviceId?: string } {
  const value = requireJsonObject(body);
  rejectUnknownKeys(value, ['username', 'password', 'deviceId']);
  return {
    username: requireString(value, 'username', { min: 1, max: 4_096, trim: false }),
    password: requireString(value, 'password', { min: 1, max: 4_096, trim: false }),
    deviceId: optionalUuid(value, 'deviceId'),
  };
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.header('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function cookieOptions(runtimeConfig: AppConfig) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: runtimeConfig.environment === 'production',
    path: WEB_REFRESH_COOKIE_PATH,
  };
}

function setRefreshCookie(
  res: Response,
  result: IssuedAuthTokens,
  runtimeConfig: AppConfig,
): void {
  res.cookie(WEB_REFRESH_COOKIE, result.refreshToken, {
    ...cookieOptions(runtimeConfig),
    expires: new Date(result.refreshTokenExpiresAt),
  });
}

function clearRefreshCookie(res: Response, runtimeConfig: AppConfig): void {
  res.clearCookie(WEB_REFRESH_COOKIE, cookieOptions(runtimeConfig));
}

function webAuthBody(result: IssuedAuthTokens) {
  return {
    accessToken: result.accessToken,
    accessTokenExpiresIn: result.accessTokenExpiresIn,
    user: result.user,
  };
}

function sendWebAuth(
  res: Response,
  result: IssuedAuthTokens,
  runtimeConfig: AppConfig,
  status = 200,
): void {
  setRefreshCookie(res, result, runtimeConfig);
  res.status(status).json(webAuthBody(result));
}

export function createWebAuthV1Router(dependencies: WebAuthV1Dependencies = {}): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const requireAccessToken = createAccessTokenMiddleware(runtimeConfig, database);
  const limiter = (max: number) => createMemoryRateLimiter({
    windowMs: 60_000,
    max,
    message: 'Too many authentication attempts',
  });
  const bootstrapLimiter = limiter(5);
  const registerLimiter = limiter(10);
  const loginLimiter = limiter(10);
  const refreshLimiter = limiter(30);

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post(
    '/bootstrap',
    ...(runtimeConfig.rateLimitEnabled ? [bootstrapLimiter] : []),
    (req, res, next) => {
      try {
        if (!runtimeConfig.bootstrapSecret) {
          throw new AppError(
            503,
            'BOOTSTRAP_NOT_CONFIGURED',
            'Server administrator bootstrap is not configured',
          );
        }
        if (!constantTimeEqual(req.header('x-bootstrap-secret') || '', runtimeConfig.bootstrapSecret)) {
          throw new AppError(403, 'BOOTSTRAP_FORBIDDEN', 'Administrator bootstrap denied');
        }
        const input = credentials(req.body);
        let result: IssuedAuthTokens;
        database().transaction(() => {
          const db = database();
          const count = Number(db.prepare('SELECT COUNT(*) FROM users').pluck().get());
          if (count > 0) {
            throw new AppError(
              409,
              'BOOTSTRAP_ALREADY_COMPLETED',
              'The first administrator has already been initialized',
            );
          }
          const user = createAccount(db, { ...input, role: 'admin' });
          result = issueTokens(db, user, runtimeConfig, req, input.deviceId);
        }).immediate();
        sendWebAuth(res, result!, runtimeConfig, 201);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/register',
    ...(runtimeConfig.rateLimitEnabled ? [registerLimiter] : []),
    (req, res, next) => {
      try {
        const input = credentials(req.body);
        const db = database();
        if (Number(db.prepare('SELECT COUNT(*) FROM users').pluck().get()) === 0) {
          throw new AppError(
            409,
            'BOOTSTRAP_REQUIRED',
            'Initialize the first administrator before public registration',
          );
        }
        const settings = db.prepare(
          'SELECT registration_enabled FROM server_settings WHERE id = 1',
        ).get() as { registration_enabled: number } | undefined;
        if (!settings?.registration_enabled) {
          throw new AppError(403, 'REGISTRATION_DISABLED', 'Registration is disabled');
        }
        let result: IssuedAuthTokens;
        db.transaction(() => {
          const user = createAccount(db, { ...input, role: 'user' });
          result = issueTokens(db, user, runtimeConfig, req, input.deviceId);
        }).immediate();
        sendWebAuth(res, result!, runtimeConfig, 201);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/login',
    ...(runtimeConfig.rateLimitEnabled ? [loginLimiter] : []),
    (req, res, next) => {
      try {
        const input = loginCredentials(req.body);
        const db = database();
        const user = verifyCredentials(db, input.username, input.password);
        requireInteractiveLoginAllowed(user, runtimeConfig);
        sendWebAuth(
          res,
          issueTokens(db, user, runtimeConfig, req, input.deviceId),
          runtimeConfig,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/refresh',
    ...(runtimeConfig.rateLimitEnabled ? [refreshLimiter] : []),
    (req, res, next) => {
      try {
        const body = req.body === undefined ? {} : requireJsonObject(req.body);
        rejectUnknownKeys(body, ['deviceId']);
        const suppliedToken = cookieValue(req, WEB_REFRESH_COOKIE);
        if (!suppliedToken) {
          throw new AppError(
            401,
            'REFRESH_TOKEN_INVALID',
            'Refresh token is invalid or expired',
          );
        }
        const result = rotateRefreshToken(
          database(),
          suppliedToken,
          runtimeConfig,
          req,
          optionalUuid(body, 'deviceId'),
        );
        sendWebAuth(res, result, runtimeConfig);
      } catch (error) {
        if (error instanceof RefreshTokenReuseError) {
          getRealtimeHub(database()).revokeUser(error.userId, 'REFRESH_TOKEN_REUSE');
        }
        if (!(error instanceof AppError && error.code === 'REFRESH_TOKEN_ROTATED')) {
          clearRefreshCookie(res, runtimeConfig);
        }
        next(error);
      }
    },
  );

  router.post('/logout', (req, res, next) => {
    try {
      const token = cookieValue(req, WEB_REFRESH_COOKIE);
      if (token) {
        const db = database();
        const identity = findRefreshTokenIdentity(db, token);
        revokeRefreshToken(db, token);
        if (identity) {
          const hub = getRealtimeHub(db);
          hub.revokeAuthSession(identity.userId, identity.authSessionId, 'SIGNED_OUT');
        }
      }
      clearRefreshCookie(res, runtimeConfig);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', requireAccessToken, (req: V1AuthRequest, res, next) => {
    try {
      const user = findAuthUserById(database(), req.auth!.userId);
      if (!user) throw new AppError(401, 'TOKEN_INVALID', 'Access token user no longer exists');
      res.json(toPublicUser(user));
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/complete-password-change',
    ...(runtimeConfig.rateLimitEnabled ? [loginLimiter] : []),
    (req, res, next) => {
      try {
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['passwordChangeToken', 'newPassword', 'deviceId']);
        const result = completeRequiredPasswordChange(
          database(),
          requireString(body, 'passwordChangeToken', { min: 32, max: 2_048 }),
          validatePassword(
            requireString(body, 'newPassword', { min: 10, max: 128, trim: false }),
            'newPassword',
          ),
          runtimeConfig,
          req,
          optionalUuid(body, 'deviceId'),
        );
        sendWebAuth(res, result, runtimeConfig);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export const webAuthV1Router = createWebAuthV1Router();
