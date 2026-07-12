import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { Request, Router } from 'express';
import jwt from 'jsonwebtoken';
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

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
}

interface RefreshTokenRow {
  id: string;
  user_id: string;
  device_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  replaced_by_id: string | null;
  username: string;
  role: string;
}

interface PublicUser {
  id: string;
  username: string;
  role: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
  const username = requireString(value, 'username', { min: 3, max: 64 });
  if (!/^[\p{L}\p{N}_.-]+$/u.test(username)) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      'username may contain only letters, numbers, dot, underscore, and hyphen',
      { field: 'username' },
    );
  }
  const password = requireString(value, 'password', { min: 10, max: 128, trim: false });
  return { username, password, deviceId: optionalUuid(value, 'deviceId') };
}

function publicUser(user: Pick<UserRow, 'id' | 'username' | 'role'>): PublicUser {
  return { id: user.id, username: user.username, role: user.role };
}

function requestMetadata(req: Request): { userAgent: string | null; ipAddress: string | null } {
  return {
    userAgent: req.header('user-agent')?.slice(0, 512) || null,
    ipAddress: (req.ip || req.socket.remoteAddress || '').slice(0, 128) || null,
  };
}

function createAccessToken(user: PublicUser, runtimeConfig: AppConfig): string {
  return jwt.sign(
    { type: 'access', role: user.role },
    runtimeConfig.jwtSecret,
    {
      algorithm: 'HS256',
      subject: user.id,
      jwtid: randomUUID(),
      issuer: runtimeConfig.jwtIssuer,
      audience: 'openlogtool-v1',
      expiresIn: runtimeConfig.accessTokenTtlSeconds,
    },
  );
}

function createRefreshToken(
  db: Database.Database,
  user: PublicUser,
  runtimeConfig: AppConfig,
  req: Request,
  deviceId?: string,
): { id: string; token: string; expiresAt: string } {
  const id = randomUUID();
  const token = randomBytes(48).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + runtimeConfig.refreshTokenTtlSeconds * 1000);
  const metadata = requestMetadata(req);
  db.prepare(`
    INSERT INTO refresh_tokens (
      id, user_id, token_hash, device_id, created_at, expires_at,
      user_agent, ip_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    user.id,
    hashToken(token),
    deviceId ?? null,
    now.toISOString(),
    expiresAt.toISOString(),
    metadata.userAgent,
    metadata.ipAddress,
  );
  return { id, token, expiresAt: expiresAt.toISOString() };
}

function issueTokens(
  db: Database.Database,
  user: PublicUser,
  runtimeConfig: AppConfig,
  req: Request,
  deviceId?: string,
) {
  const refresh = createRefreshToken(db, user, runtimeConfig, req, deviceId);
  return {
    accessToken: createAccessToken(user, runtimeConfig),
    accessTokenExpiresIn: runtimeConfig.accessTokenTtlSeconds,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
    user,
  };
}

export function createAuthV1Router(dependencies: AuthV1Dependencies = {}): Router {
  const router = Router();
  const db = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const requireAccessToken = createAccessTokenMiddleware(runtimeConfig);
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
        const user: PublicUser = {
          id: randomUUID(),
          username: credentials.username,
          role: 'admin',
        };
        const passwordHash = bcrypt.hashSync(credentials.password, 10);
        const now = new Date().toISOString();
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
          database.prepare(`
            INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
            VALUES (?, ?, ?, 'admin', ?, ?)
          `).run(user.id, user.username, passwordHash, now, now);
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

        const user: PublicUser = {
          id: randomUUID(),
          username: credentials.username,
          role: 'user',
        };
        const passwordHash = bcrypt.hashSync(credentials.password, 10);
        const now = new Date().toISOString();
        let authResult: ReturnType<typeof issueTokens>;
        const transaction = database.transaction(() => {
          database.prepare(`
            INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
            VALUES (?, ?, ?, 'user', ?, ?)
          `).run(user.id, user.username, passwordHash, now, now);
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
        const credentials = validateCredentials(req.body);
        const database = db();
        const user = database.prepare('SELECT * FROM users WHERE username = ?').get(
          credentials.username,
        ) as UserRow | undefined;
        if (!user || !bcrypt.compareSync(credentials.password, user.password_hash)) {
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect');
        }
        res.json(issueTokens(database, publicUser(user), runtimeConfig, req, credentials.deviceId));
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
        const row = database.prepare(`
          SELECT rt.id, rt.user_id, rt.device_id, rt.expires_at, rt.revoked_at,
                 rt.replaced_by_id,
                 u.username, u.role
          FROM refresh_tokens rt
          JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = ?
        `).get(hashToken(suppliedToken)) as RefreshTokenRow | undefined;

        if (row?.revoked_at && row.replaced_by_id) {
          database.prepare(`
            UPDATE refresh_tokens
            SET revoked_at = COALESCE(revoked_at, ?)
            WHERE user_id = ? AND revoked_at IS NULL
          `).run(new Date().toISOString(), row.user_id);
        }
        if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
          throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
        }

        const user: PublicUser = { id: row.user_id, username: row.username, role: row.role };
        let authResult: ReturnType<typeof issueTokens>;
        const transaction = database.transaction(() => {
          const now = new Date().toISOString();
          const update = database.prepare(`
            UPDATE refresh_tokens
            SET revoked_at = ?, rotated_at = ?, last_used_at = ?
            WHERE id = ? AND revoked_at IS NULL
          `).run(now, now, now, row.id);
          if (update.changes !== 1) {
            throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
          }
          authResult = issueTokens(
            database,
            user,
            runtimeConfig,
            req,
            deviceId ?? row.device_id ?? undefined,
          );
          const replacement = database.prepare(`
            SELECT id FROM refresh_tokens WHERE token_hash = ?
          `).get(hashToken(authResult.refreshToken)) as { id: string };
          database.prepare('UPDATE refresh_tokens SET replaced_by_id = ? WHERE id = ?').run(
            replacement.id,
            row.id,
          );
        });
        transaction();
        res.json(authResult!);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/logout', requireAccessToken, (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['refreshToken']);
      const suppliedToken = requireString(body, 'refreshToken', { min: 32, max: 512 });
      db().prepare(`
        UPDATE refresh_tokens
        SET revoked_at = COALESCE(revoked_at, ?), last_used_at = ?
        WHERE user_id = ? AND token_hash = ?
      `).run(
        new Date().toISOString(),
        new Date().toISOString(),
        req.auth!.userId,
        hashToken(suppliedToken),
      );
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', requireAccessToken, (req: V1AuthRequest, res, next) => {
    try {
      const user = db().prepare('SELECT id, username, role FROM users WHERE id = ?').get(
        req.auth!.userId,
      ) as PublicUser | undefined;
      if (!user) throw new AppError(401, 'TOKEN_INVALID', 'Access token user no longer exists');
      res.setHeader('Cache-Control', 'no-store');
      res.json(user);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const authV1Router = createAuthV1Router();
