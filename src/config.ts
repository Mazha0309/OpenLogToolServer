import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  port: number;
  dbPath: string;
  jwtSecret: string;
  jwtIssuer: string;
  bootstrapSecret: string;
  inviteHmacKey: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  corsOrigins: string[];
  trustProxy: boolean | number;
  jsonBodyLimit: string;
  rateLimitEnabled: boolean;
  environment: string;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePort(value: string | undefined): number {
  const port = parsePositiveInteger(value, 3000, 'PORT');
  if (port > 65_535) throw new Error('PORT must be between 1 and 65535');
  return port;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseTrustProxy(value: string | undefined): boolean | number {
  if (value == null || value.trim() === '') return false;
  if (/^(true|yes)$/i.test(value)) return true;
  if (/^(false|no)$/i.test(value)) return false;
  const hops = Number(value);
  if (Number.isSafeInteger(hops) && hops >= 0) return hops;
  throw new Error('TRUST_PROXY must be true, false, or a non-negative hop count');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const refreshSeconds = env.REFRESH_TOKEN_TTL_SECONDS
    ? parsePositiveInteger(env.REFRESH_TOKEN_TTL_SECONDS, 30 * 86_400, 'REFRESH_TOKEN_TTL_SECONDS')
    : parsePositiveInteger(env.REFRESH_TOKEN_TTL_DAYS, 30, 'REFRESH_TOKEN_TTL_DAYS') * 86_400;

  return {
    port: parsePort(env.PORT),
    dbPath: env.DB_PATH?.trim() || './data/openlogtool.db',
    jwtSecret: env.JWT_SECRET?.trim() || '',
    jwtIssuer: env.JWT_ISSUER?.trim() || 'openlogtool-server',
    bootstrapSecret: env.ADMIN_BOOTSTRAP_TOKEN?.trim() || '',
    inviteHmacKey: env.INVITE_HMAC_KEY?.trim() || '',
    accessTokenTtlSeconds: parsePositiveInteger(
      env.ACCESS_TOKEN_TTL_SECONDS,
      15 * 60,
      'ACCESS_TOKEN_TTL_SECONDS',
    ),
    refreshTokenTtlSeconds: refreshSeconds,
    corsOrigins: (env.CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    jsonBodyLimit: env.JSON_BODY_LIMIT?.trim() || '1mb',
    rateLimitEnabled: parseBoolean(env.RATE_LIMIT_ENABLED, true),
    environment: env.NODE_ENV?.trim() || 'development',
  };
}

export function validateRuntimeConfig(
  value: AppConfig,
  options: { requireBootstrapSecret?: boolean; requireInviteHmacKey?: boolean } = {},
): void {
  if (Buffer.byteLength(value.jwtSecret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be explicitly set to at least 32 bytes');
  }
  if (options.requireBootstrapSecret && Buffer.byteLength(value.bootstrapSecret, 'utf8') < 24) {
    throw new Error(
      'ADMIN_BOOTSTRAP_TOKEN must be explicitly set to at least 24 bytes until the first admin is created',
    );
  }
  if (options.requireInviteHmacKey && Buffer.byteLength(value.inviteHmacKey, 'utf8') < 32) {
    throw new Error('INVITE_HMAC_KEY must be explicitly set to at least 32 bytes');
  }
}

export const config = loadConfig();
