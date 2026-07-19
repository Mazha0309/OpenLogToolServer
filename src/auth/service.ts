import { createHash, randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { Request } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { AppConfig } from '../config';
import { AppError } from '../errors/app-error';
import { normalizeUsernameDisplay, usernameIdentity } from './username-identity';

export const PASSWORD_CHANGE_TOKEN_TTL_SECONDS = 5 * 60;
export const PERSISTENT_LOGIN_EXPIRES_AT = '9999-12-31T23:59:59.999Z';

export interface AuthUserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  disabled_at: string | null;
  deleted_at: string | null;
  must_change_password: number;
  login_never_expires: number;
  auth_version: number;
  password_changed_at: string | null;
  username_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: string;
  username: string;
  role: string;
}

export interface IssuedAuthTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: PublicUser;
}

export interface RefreshTokenIdentity {
  userId: string;
  refreshTokenId: string;
  deviceId: string | null;
  authSessionId: string;
}

export class RefreshTokenReuseError extends AppError {
  constructor(readonly userId: string) {
    super(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
  }
}

interface RefreshTokenRow {
  id: string;
  user_id: string;
  device_id: string | null;
  auth_session_id: string | null;
  issued_auth_version: number | null;
  expires_at: string;
  revoked_at: string | null;
  rotated_at: string | null;
  replaced_by_id: string | null;
  username: string;
  role: string;
  disabled_at: string | null;
  deleted_at: string | null;
  must_change_password: number;
  login_never_expires: number;
  auth_version: number;
  password_hash: string;
  password_changed_at: string | null;
  username_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PasswordChangePayload extends JwtPayload {
  type: 'password_change';
  av: number;
  sub: string;
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function validateUsername(username: string): string {
  const normalized = normalizeUsernameDisplay(username.trim());
  if (normalized.length < 3 || normalized.length > 64) {
    throw new AppError(422, 'VALIDATION_FAILED', 'username length must be between 3 and 64', {
      field: 'username',
      min: 3,
      max: 64,
    });
  }
  if (!/^[\p{L}\p{N}_.-]+$/u.test(normalized)) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      'username may contain only letters, numbers, dot, underscore, and hyphen',
      { field: 'username' },
    );
  }
  if (normalized.toLowerCase().startsWith('deleted-')) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      'username uses a reserved account namespace',
      { field: 'username' },
    );
  }
  return normalized;
}

export function validatePassword(password: string, field = 'password'): string {
  if (password.length < 8 || password.length > 128) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      `${field} length must be between 8 and 128`,
      { field, min: 8, max: 128 },
    );
  }
  return password;
}

export function toPublicUser(
  user: Pick<AuthUserRow, 'id' | 'username' | 'role'>,
): PublicUser {
  return { id: user.id, username: user.username, role: user.role };
}

export function findAuthUserById(
  db: Database.Database,
  userId: string,
): AuthUserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as AuthUserRow | undefined;
}

export function findAuthUserByUsername(
  db: Database.Database,
  username: string,
): AuthUserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username_identity(username) = ?')
    .get(usernameIdentity(username)) as
    | AuthUserRow
    | undefined;
}

export function createAccount(
  db: Database.Database,
  input: { username: string; password: string; role: 'admin' | 'user' },
): AuthUserRow {
  const username = validateUsername(input.username);
  const password = validatePassword(input.password);
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO users (
        id, username, password_hash, role, auth_version,
        must_change_password, password_changed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)
    `).run(id, username, bcrypt.hashSync(password, 10), input.role, now, now, now);
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      throw new AppError(409, 'USERNAME_TAKEN', 'Username is already registered');
    }
    throw error;
  }
  return findAuthUserById(db, id)!;
}

export function verifyCredentials(
  db: Database.Database,
  username: string,
  password: string,
): AuthUserRow {
  const user = findAuthUserByUsername(db, username);
  if (!user || user.deleted_at || !bcrypt.compareSync(password, user.password_hash)) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect');
  }
  return user;
}

function passwordChangeToken(user: AuthUserRow, runtimeConfig: AppConfig): string {
  return jwt.sign(
    { type: 'password_change', av: Number(user.auth_version) },
    runtimeConfig.jwtSecret,
    {
      algorithm: 'HS256',
      subject: user.id,
      jwtid: randomUUID(),
      issuer: runtimeConfig.jwtIssuer,
      audience: 'openlogtool-password-change',
      expiresIn: PASSWORD_CHANGE_TOKEN_TTL_SECONDS,
    },
  );
}

export function requireInteractiveLoginAllowed(
  user: AuthUserRow,
  runtimeConfig: AppConfig,
): void {
  if (user.deleted_at) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect');
  }
  if (user.disabled_at) {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled', {
      disabledAt: user.disabled_at,
    });
  }
  if (Number(user.must_change_password) === 1) {
    throw new AppError(
      403,
      'PASSWORD_CHANGE_REQUIRED',
      'The temporary password must be changed before continuing',
      {
        passwordChangeToken: passwordChangeToken(user, runtimeConfig),
        passwordChangeTokenExpiresIn: PASSWORD_CHANGE_TOKEN_TTL_SECONDS,
        user: toPublicUser(user),
      },
    );
  }
}

function requestMetadata(req: Request): { userAgent: string | null; ipAddress: string | null } {
  return {
    userAgent: req.header('user-agent')?.slice(0, 512) || null,
    ipAddress: (req.ip || req.socket.remoteAddress || '').slice(0, 128) || null,
  };
}

function createAccessToken(
  user: AuthUserRow,
  authSessionId: string,
  runtimeConfig: AppConfig,
): string {
  return jwt.sign(
    {
      type: 'access',
      role: user.role,
      av: Number(user.auth_version),
      sid: authSessionId,
    },
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
  user: AuthUserRow,
  runtimeConfig: AppConfig,
  req: Request,
  deviceId?: string,
  existingAuthSessionId?: string,
): { id: string; token: string; expiresAt: string; authSessionId: string } {
  const id = randomUUID();
  const authSessionId = existingAuthSessionId ?? randomUUID();
  const token = randomBytes(48).toString('base64url');
  const now = new Date();
  const expiresAt = Number(user.login_never_expires) === 1
    ? PERSISTENT_LOGIN_EXPIRES_AT
    : new Date(now.getTime() + runtimeConfig.refreshTokenTtlSeconds * 1000).toISOString();
  const revokedBefore = new Date(
    now.getTime() - runtimeConfig.refreshTokenTtlSeconds * 1000,
  ).toISOString();
  const metadata = requestMetadata(req);
  db.prepare(`
    DELETE FROM refresh_tokens
    WHERE id IN (
      SELECT id FROM refresh_tokens
      WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)
      ORDER BY expires_at ASC
      LIMIT 1000
    )
  `).run(now.toISOString(), revokedBefore);
  db.prepare(`
    INSERT INTO refresh_tokens (
      id, user_id, token_hash, device_id, auth_session_id, issued_auth_version,
      created_at, expires_at, last_used_at, user_agent, ip_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    user.id,
    hashOpaqueToken(token),
    deviceId ?? null,
    authSessionId,
    Number(user.auth_version),
    now.toISOString(),
    expiresAt,
    now.toISOString(),
    metadata.userAgent,
    metadata.ipAddress,
  );
  return { id, token, expiresAt, authSessionId };
}

export function issueTokens(
  db: Database.Database,
  user: AuthUserRow,
  runtimeConfig: AppConfig,
  req: Request,
  deviceId?: string,
  authSessionId?: string,
): IssuedAuthTokens {
  const refresh = createRefreshToken(
    db,
    user,
    runtimeConfig,
    req,
    deviceId,
    authSessionId,
  );
  return {
    accessToken: createAccessToken(user, refresh.authSessionId, runtimeConfig),
    accessTokenExpiresIn: runtimeConfig.accessTokenTtlSeconds,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
    user: toPublicUser(user),
  };
}

function refreshRow(db: Database.Database, token: string): RefreshTokenRow | undefined {
  return db.prepare(`
    SELECT
      rt.id, rt.user_id, rt.device_id, rt.auth_session_id, rt.issued_auth_version,
      rt.expires_at, rt.revoked_at, rt.rotated_at,
      rt.replaced_by_id,
      u.username, u.role, u.disabled_at, u.deleted_at, u.must_change_password,
      u.login_never_expires, u.auth_version, u.password_hash, u.password_changed_at,
      u.username_changed_at, u.created_at, u.updated_at
    FROM refresh_tokens rt
    JOIN users u ON u.id = rt.user_id
    WHERE rt.token_hash = ?
  `).get(hashOpaqueToken(token)) as RefreshTokenRow | undefined;
}

function authUserFromRefresh(row: RefreshTokenRow): AuthUserRow {
  return {
    id: row.user_id,
    username: row.username,
    password_hash: row.password_hash,
    role: row.role,
    disabled_at: row.disabled_at,
    deleted_at: row.deleted_at,
    must_change_password: row.must_change_password,
    login_never_expires: row.login_never_expires,
    auth_version: row.auth_version,
    password_changed_at: row.password_changed_at,
    username_changed_at: row.username_changed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function rotateRefreshToken(
  db: Database.Database,
  suppliedToken: string,
  runtimeConfig: AppConfig,
  req: Request,
  deviceId?: string,
): IssuedAuthTokens {
  const row = refreshRow(db, suppliedToken);
  if (!row || Date.parse(row.expires_at) <= Date.now()) {
    throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
  }
  const user = authUserFromRefresh(row);
  if (
    row.issued_auth_version === null ||
    Number(row.issued_auth_version) !== Number(user.auth_version)
  ) {
    throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
  }
  if (user.deleted_at) {
    throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
  }
  if (user.disabled_at) {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled', {
      disabledAt: user.disabled_at,
    });
  }
  if (Number(user.must_change_password) === 1) {
    throw new AppError(
      403,
      'PASSWORD_CHANGE_REQUIRED',
      'Sign in with the temporary password to complete the required password change',
      { loginRequired: true },
    );
  }
  if (row?.revoked_at && row.replaced_by_id) {
    const rotatedAt = Date.parse(row.rotated_at ?? row.revoked_at);
    if (Number.isFinite(rotatedAt) && Date.now() - rotatedAt <= 10_000) {
      throw new AppError(
        409,
        'REFRESH_TOKEN_ROTATED',
        'The refresh credential was just rotated; retry with the latest credential',
        { retryAfterMilliseconds: 100 },
      );
    }
    db.prepare(`
      UPDATE refresh_tokens
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), row.user_id);
    throw new RefreshTokenReuseError(row.user_id);
  }
  if (row.revoked_at) {
    throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
  }

  let result: IssuedAuthTokens;
  db.transaction(() => {
    const rotatedAt = new Date();
    const now = rotatedAt.toISOString();
    const retiredPersistentExpiry = new Date(
      rotatedAt.getTime() + runtimeConfig.refreshTokenTtlSeconds * 1000,
    ).toISOString();
    const update = db.prepare(`
      UPDATE refresh_tokens
      SET revoked_at = ?, rotated_at = ?, last_used_at = ?,
          expires_at = CASE WHEN expires_at = ? THEN ? ELSE expires_at END
      WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
    `).run(
      now,
      now,
      now,
      PERSISTENT_LOGIN_EXPIRES_AT,
      retiredPersistentExpiry,
      row.id,
      now,
    );
    if (update.changes !== 1) {
      throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
    }
    result = issueTokens(
      db,
      user,
      runtimeConfig,
      req,
      row.device_id ?? deviceId,
      row.auth_session_id ?? row.id,
    );
    const replacement = db.prepare(
      'SELECT id FROM refresh_tokens WHERE token_hash = ?',
    ).get(hashOpaqueToken(result.refreshToken)) as { id: string };
    db.prepare('UPDATE refresh_tokens SET replaced_by_id = ? WHERE id = ?').run(
      replacement.id,
      row.id,
    );
  }).immediate();
  return result!;
}

export function revokeRefreshToken(
  db: Database.Database,
  suppliedToken: string,
  userId?: string,
): number {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT id, user_id, device_id, auth_session_id FROM refresh_tokens
      WHERE token_hash = ?
    `).get(hashOpaqueToken(suppliedToken)) as {
      id: string;
      user_id: string;
      device_id: string | null;
      auth_session_id: string | null;
    } | undefined;
    if (!row || (userId !== undefined && row.user_id !== userId)) return 0;
    const result = row.auth_session_id
      ? db.prepare(`
          UPDATE refresh_tokens
          SET revoked_at = COALESCE(revoked_at, ?), last_used_at = ?
          WHERE user_id = ? AND auth_session_id = ? AND revoked_at IS NULL
        `).run(now, now, row.user_id, row.auth_session_id)
      : db.prepare(`
          UPDATE refresh_tokens
          SET revoked_at = COALESCE(revoked_at, ?), last_used_at = ?
          WHERE id = ? AND revoked_at IS NULL
        `).run(now, now, row.id);
    return Number(result.changes);
  }).immediate();
}

export function findRefreshTokenIdentity(
  db: Database.Database,
  suppliedToken: string,
): RefreshTokenIdentity | undefined {
  const row = db.prepare(`
    SELECT id, user_id, device_id, auth_session_id
    FROM refresh_tokens
    WHERE token_hash = ?
  `).get(hashOpaqueToken(suppliedToken)) as {
    id: string;
    user_id: string;
    device_id: string | null;
    auth_session_id: string | null;
  } | undefined;
  return row
    ? {
        userId: row.user_id,
        refreshTokenId: row.id,
        deviceId: row.device_id,
        authSessionId: row.auth_session_id ?? row.id,
      }
    : undefined;
}

function decodePasswordChangeToken(
  token: string,
  runtimeConfig: AppConfig,
): PasswordChangePayload {
  let payload: string | JwtPayload;
  try {
    payload = jwt.verify(token, runtimeConfig.jwtSecret, {
      algorithms: ['HS256'],
      issuer: runtimeConfig.jwtIssuer,
      audience: 'openlogtool-password-change',
    });
  } catch {
    throw new AppError(
      401,
      'PASSWORD_CHANGE_TOKEN_INVALID',
      'The password-change credential is invalid or expired',
    );
  }
  if (
    typeof payload === 'string' ||
    payload.type !== 'password_change' ||
    typeof payload.sub !== 'string' ||
    !Number.isSafeInteger(payload.av) ||
    Number(payload.av) < 1
  ) {
    throw new AppError(
      401,
      'PASSWORD_CHANGE_TOKEN_INVALID',
      'The password-change credential is invalid or expired',
    );
  }
  return payload as PasswordChangePayload;
}

export function completeRequiredPasswordChange(
  db: Database.Database,
  token: string,
  newPassword: string,
  runtimeConfig: AppConfig,
  req: Request,
  deviceId?: string,
): IssuedAuthTokens {
  const payload = decodePasswordChangeToken(token, runtimeConfig);
  const password = validatePassword(newPassword, 'newPassword');
  let result: IssuedAuthTokens;
  db.transaction(() => {
    const user = findAuthUserById(db, payload.sub);
    if (
      !user ||
      user.deleted_at ||
      user.disabled_at ||
      Number(user.must_change_password) !== 1 ||
      Number(user.auth_version) !== Number(payload.av)
    ) {
      throw new AppError(
        401,
        'PASSWORD_CHANGE_TOKEN_INVALID',
        'The password-change credential is invalid or expired',
      );
    }
    if (bcrypt.compareSync(password, user.password_hash)) {
      throw new AppError(
        409,
        'PASSWORD_UNCHANGED',
        'The new password must differ from the temporary password',
      );
    }
    const now = new Date().toISOString();
    const update = db.prepare(`
      UPDATE users
      SET password_hash = ?, must_change_password = 0,
          auth_version = auth_version + 1,
          password_changed_at = ?, updated_at = ?
      WHERE id = ? AND auth_version = ? AND must_change_password = 1
        AND disabled_at IS NULL AND deleted_at IS NULL
    `).run(
      bcrypt.hashSync(password, 10),
      now,
      now,
      user.id,
      user.auth_version,
    );
    if (update.changes !== 1) {
      throw new AppError(
        401,
        'PASSWORD_CHANGE_TOKEN_INVALID',
        'The password-change credential is invalid or expired',
      );
    }
    db.prepare(`
      UPDATE refresh_tokens
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(now, user.id);
    result = issueTokens(db, findAuthUserById(db, user.id)!, runtimeConfig, req, deviceId);
  }).immediate();
  return result!;
}
