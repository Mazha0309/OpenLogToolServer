import { timingSafeEqual } from 'crypto';
import Database from 'better-sqlite3';
import { Router } from 'express';
import {
  completeRequiredPasswordChange,
  createAccount,
  findAuthUserById,
  findRefreshTokenIdentity,
  issueTokens,
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
import {
  createAccessTokenMiddleware,
  V1AuthRequest,
} from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import {
  optionalUuid,
  rejectUnknownKeys,
  requireJsonObject,
  requireString,
} from '../utils/validation';

interface AuthV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function validateCredentials(body: unknown): {
  username: string;
  password: string;
  deviceId?: string;
} {
  const value = requireJsonObject(body);
  rejectUnknownKeys(value, ['username', 'password', 'deviceId']);
  const username = validateUsername(requireString(value, 'username', { min: 3, max: 64 }));
  const password = validatePassword(
    requireString(value, 'password', { min: 10, max: 128, trim: false }),
  );
  return { username, password, deviceId: optionalUuid(value, 'deviceId') };
}

function validateLoginCredentials(body: unknown): {
  username: string;
  password: string;
  deviceId?: string;
} {
  const value = requireJsonObject(body);
  rejectUnknownKeys(value, ['username', 'password', 'deviceId']);
  return {
    // v0 accepted any non-empty strings. Keep upgraded accounts reachable while
    // applying the stricter policy only to newly created or renamed accounts.
    username: requireString(value, 'username', { min: 1, max: 4_096, trim: false }),
    password: requireString(value, 'password', { min: 1, max: 4_096, trim: false }),
    deviceId: optionalUuid(value, 'deviceId'),
  };
}

export function createAuthV1Router(dependencies: AuthV1Dependencies = {}): Router {
  const router = Router();
  const db = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const requireAccessToken = createAccessTokenMiddleware(runtimeConfig, db);
  const limiter = (max: number) =>
    createMemoryRateLimiter({ windowMs: 60_000, max, message: 'Too many authentication attempts' });
  const bootstrapLimiter = limiter(5);
  const registerLimiter = limiter(10);
  const loginLimiter = limiter(10);
  const refreshLimiter = limiter(30);

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
        const supplied = req.header('x-bootstrap-secret') || '';
        if (!constantTimeEqual(supplied, runtimeConfig.bootstrapSecret)) {
          throw new AppError(403, 'BOOTSTRAP_FORBIDDEN', 'Administrator bootstrap denied');
        }
        const credentials = validateCredentials(req.body);
        const database = db();
        let authResult: ReturnType<typeof issueTokens>;
        const transaction = database.transaction(() => {
          const count = database.prepare('SELECT COUNT(*) AS count FROM users').get() as {
            count: number;
          };
          if (Number(count.count) > 0) {
            throw new AppError(
              409,
              'BOOTSTRAP_ALREADY_COMPLETED',
              'The first administrator has already been initialized',
            );
          }
          const user = createAccount(database, {
            username: credentials.username,
            password: credentials.password,
            role: 'admin',
          });
          authResult = issueTokens(database, user, runtimeConfig, req, credentials.deviceId);
        });
        transaction.immediate();
        res.status(201).json(authResult!);
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
        const credentials = validateCredentials(req.body);
        const database = db();
        const userCount = database.prepare('SELECT COUNT(*) AS count FROM users').get() as {
          count: number;
        };
        if (Number(userCount.count) === 0) {
          throw new AppError(
            409,
            'BOOTSTRAP_REQUIRED',
            'Initialize the first administrator before public registration',
          );
        }
        const settings = database
          .prepare('SELECT registration_enabled FROM server_settings WHERE id = 1')
          .get() as { registration_enabled: number } | undefined;
        if (!settings?.registration_enabled) {
          throw new AppError(403, 'REGISTRATION_DISABLED', 'Registration is disabled');
        }
        if (database.prepare('SELECT 1 FROM users WHERE username = ?').get(credentials.username)) {
          throw new AppError(409, 'USERNAME_TAKEN', 'Username is already registered');
        }

        let authResult: ReturnType<typeof issueTokens>;
        const transaction = database.transaction(() => {
          const user = createAccount(database, {
            username: credentials.username,
            password: credentials.password,
            role: 'user',
          });
          authResult = issueTokens(database, user, runtimeConfig, req, credentials.deviceId);
        });
        transaction();
        res.status(201).json(authResult!);
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
        const credentials = validateLoginCredentials(req.body);
        const database = db();
        const user = verifyCredentials(database, credentials.username, credentials.password);
        requireInteractiveLoginAllowed(user, runtimeConfig);
        res.json(issueTokens(database, user, runtimeConfig, req, credentials.deviceId));
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
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['refreshToken', 'deviceId']);
        const suppliedToken = requireString(body, 'refreshToken', { min: 32, max: 512 });
        const deviceId = optionalUuid(body, 'deviceId');
        const database = db();
        res.json(rotateRefreshToken(database, suppliedToken, runtimeConfig, req, deviceId));
      } catch (error) {
        if (error instanceof RefreshTokenReuseError) {
          getRealtimeHub(db()).revokeUser(error.userId, 'REFRESH_TOKEN_REUSE');
        }
        next(error);
      }
    },
  );

  router.post('/logout', requireAccessToken, (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['refreshToken']);
      const suppliedToken = requireString(body, 'refreshToken', { min: 32, max: 512 });
      const database = db();
      const identity = findRefreshTokenIdentity(database, suppliedToken);
      revokeRefreshToken(database, suppliedToken, req.auth!.userId);
      if (identity?.userId === req.auth!.userId) {
        const hub = getRealtimeHub(database);
        hub.revokeAuthSession(identity.userId, identity.authSessionId, 'SIGNED_OUT');
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', requireAccessToken, (req: V1AuthRequest, res, next) => {
    try {
      const stored = findAuthUserById(db(), req.auth!.userId);
      const user = stored ? toPublicUser(stored) : undefined;
      if (!user) throw new AppError(401, 'TOKEN_INVALID', 'Access token user no longer exists');
      res.setHeader('Cache-Control', 'no-store');
      res.json(user);
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
        const token = requireString(body, 'passwordChangeToken', { min: 32, max: 2_048 });
        const newPassword = validatePassword(
          requireString(body, 'newPassword', { min: 10, max: 128, trim: false }),
          'newPassword',
        );
        const deviceId = optionalUuid(body, 'deviceId');
        res.json(
          completeRequiredPasswordChange(
            db(),
            token,
            newPassword,
            runtimeConfig,
            req,
            deviceId,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export const authV1Router = createAuthV1Router();
