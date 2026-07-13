import { createHash, createHmac, randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { AppConfig } from '../config';
import { AppError } from '../errors/app-error';
import { SessionRow } from './access';
import { CollaborationEvent } from './events';

export interface PublicShareRow {
  id: string;
  session_id: string;
  credential_version: number;
  secret_hash: string;
  expires_at: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface PublicLogRow {
  sync_id: string;
  time: string;
  controller: string;
  callsign: string;
  rst_sent: string | null;
  rst_rcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
  deleted_at: string | null;
}

export interface PublicAccessIdentity {
  publicShareId: string;
  sessionId: string;
  tokenId: string;
  expiresAt: string;
}

const PUBLIC_SHARE_SECRET_DOMAIN = 'openlogtool/public-share-secret/v1';
const PUBLIC_SHARE_LOOKUP_DOMAIN = 'openlogtool/public-share-lookup/v1';
const PUBLIC_SHARE_FINGERPRINT_DOMAIN = 'openlogtool/public-share-hmac-key/v1';
const PUBLIC_ACCESS_KEY_DOMAIN = 'openlogtool/public-access-signing-key/v1';
export const PUBLIC_ACCESS_AUDIENCE = 'openlogtool-public-v1';
export const PUBLIC_ACCESS_TYPE = 'public-share-access';
export const PUBLIC_ACCESS_TTL_SECONDS = 5 * 60;

function publicAccessSigningKey(config: AppConfig): Buffer {
  return createHmac('sha256', config.jwtSecret)
    .update(PUBLIC_ACCESS_KEY_DOMAIN)
    .digest();
}

function publicShareFingerprint(config: AppConfig): string {
  return createHash('sha256')
    .update(`${PUBLIC_SHARE_FINGERPRINT_DOMAIN}\0`)
    .update(config.publicShareHmacKey)
    .digest('hex');
}

export function publicShareFeatureAvailable(
  db: Database.Database,
  config: AppConfig,
): boolean {
  if (Buffer.byteLength(config.publicShareHmacKey || '', 'utf8') < 32) return false;
  const row = db.prepare(`
    SELECT public_share_hmac_fingerprint FROM server_settings WHERE id = 1
  `).get() as { public_share_hmac_fingerprint?: string | null } | undefined;
  return !row?.public_share_hmac_fingerprint ||
    row.public_share_hmac_fingerprint === publicShareFingerprint(config);
}

export function assertPublicShareConfig(
  db: Database.Database,
  config: AppConfig,
): void {
  if (Buffer.byteLength(config.publicShareHmacKey || '', 'utf8') < 32) {
    throw new AppError(
      503,
      'PUBLIC_SHARE_HMAC_NOT_CONFIGURED',
      'Public Liveshare is not configured',
    );
  }
  const fingerprint = publicShareFingerprint(config);
  db.prepare(`
    UPDATE server_settings
    SET public_share_hmac_fingerprint = ?
    WHERE id = 1 AND public_share_hmac_fingerprint IS NULL
  `).run(fingerprint);
  const row = db.prepare(`
    SELECT public_share_hmac_fingerprint FROM server_settings WHERE id = 1
  `).get() as { public_share_hmac_fingerprint?: string | null } | undefined;
  if (row?.public_share_hmac_fingerprint !== fingerprint) {
    throw new AppError(
      503,
      'PUBLIC_SHARE_HMAC_KEY_CHANGED',
      'The public share HMAC key does not match this server database',
    );
  }
}

export function derivePublicShareSecret(config: AppConfig, publicShareId: string): string {
  return createHmac('sha256', config.publicShareHmacKey)
    .update(`${PUBLIC_SHARE_SECRET_DOMAIN}\0${publicShareId}`)
    .digest('base64url');
}

export function hashPublicShareSecret(config: AppConfig, secret: string): string {
  return createHmac('sha256', config.publicShareHmacKey)
    .update(`${PUBLIC_SHARE_LOOKUP_DOMAIN}\0${secret}`)
    .digest('hex');
}

export function hashPublicWsTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

export function issuePublicAccessToken(
  config: AppConfig,
  input: { publicShareId: string; sessionId: string; shareExpiresAt: string },
): { accessToken: string; expiresAt: string } {
  const nowSeconds = Date.now() / 1_000;
  const shareExpiresAtSeconds = Date.parse(input.shareExpiresAt) / 1_000;
  if (shareExpiresAtSeconds <= nowSeconds) {
    throw new AppError(404, 'PUBLIC_SHARE_INVALID', 'Public share is invalid or unavailable');
  }
  const expiresAtSeconds = Math.min(
    nowSeconds + PUBLIC_ACCESS_TTL_SECONDS,
    shareExpiresAtSeconds,
  );
  const accessToken = jwt.sign(
    {
      type: PUBLIC_ACCESS_TYPE,
      publicShareId: input.publicShareId,
      sessionId: input.sessionId,
      iat: nowSeconds,
      exp: expiresAtSeconds,
    },
    publicAccessSigningKey(config),
    {
      algorithm: 'HS256',
      issuer: config.jwtIssuer,
      audience: PUBLIC_ACCESS_AUDIENCE,
      jwtid: randomUUID(),
    },
  );
  return {
    accessToken,
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
  };
}

export function verifyPublicAccessToken(
  config: AppConfig,
  token: string,
): PublicAccessIdentity {
  const payload = jwt.verify(token, publicAccessSigningKey(config), {
    algorithms: ['HS256'],
    issuer: config.jwtIssuer,
    audience: PUBLIC_ACCESS_AUDIENCE,
  });
  if (
    typeof payload === 'string' ||
    payload.type !== PUBLIC_ACCESS_TYPE ||
    typeof payload.publicShareId !== 'string' ||
    typeof payload.sessionId !== 'string' ||
    typeof payload.jti !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.sub !== undefined ||
    (payload as JwtPayload & { role?: unknown }).role !== undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.publicShareId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.sessionId)
  ) {
    throw new Error('Invalid public access token claims');
  }
  return {
    publicShareId: payload.publicShareId,
    sessionId: payload.sessionId,
    tokenId: payload.jti,
    expiresAt: new Date(payload.exp * 1_000).toISOString(),
  };
}

export function publicShareDto(row: PublicShareRow) {
  return {
    publicShareId: row.id,
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

export function publicSessionDto(row: SessionRow) {
  return {
    sessionId: row.id,
    title: row.title,
    status: row.status,
    closedAt: row.closed_at,
    deletedAt: row.deleted_at,
  };
}

export function publicLogDto(row: PublicLogRow) {
  return {
    syncId: row.sync_id,
    time: row.time,
    controller: row.controller,
    callsign: row.callsign,
    rstSent: row.rst_sent,
    rstRcvd: row.rst_rcvd,
    qth: row.qth,
    device: row.device,
    power: row.power,
    antenna: row.antenna,
    height: row.height,
    remarks: row.remarks,
    deletedAt: row.deleted_at,
  };
}

function storedPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(500, 'PUBLIC_EVENT_INVALID', 'Stored public event payload is invalid');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== 'string') {
    throw new AppError(500, 'PUBLIC_EVENT_INVALID', 'Stored public event payload is invalid');
  }
  return value[field] as string;
}

function nullableString(value: Record<string, unknown>, field: string): string | null {
  if (value[field] !== null && typeof value[field] !== 'string') {
    throw new AppError(500, 'PUBLIC_EVENT_INVALID', 'Stored public event payload is invalid');
  }
  return value[field] as string | null;
}

function publicLogEventPayload(value: unknown) {
  const payload = storedPayload(value);
  return {
    syncId: requiredString(payload, 'syncId'),
    time: requiredString(payload, 'time'),
    controller: requiredString(payload, 'controller'),
    callsign: requiredString(payload, 'callsign'),
    rstSent: nullableString(payload, 'rstSent'),
    rstRcvd: nullableString(payload, 'rstRcvd'),
    qth: nullableString(payload, 'qth'),
    device: nullableString(payload, 'device'),
    power: nullableString(payload, 'power'),
    antenna: nullableString(payload, 'antenna'),
    height: nullableString(payload, 'height'),
    remarks: nullableString(payload, 'remarks'),
    deletedAt: nullableString(payload, 'deletedAt'),
  };
}

function publicSessionEventPayload(value: unknown) {
  const payload = storedPayload(value);
  return {
    sessionId: requiredString(payload, 'sessionId'),
    title: requiredString(payload, 'title'),
    status: requiredString(payload, 'status'),
    closedAt: nullableString(payload, 'closedAt'),
    deletedAt: nullableString(payload, 'deletedAt'),
  };
}

export function projectPublicEvent(event: CollaborationEvent) {
  return {
    protocolVersion: 1 as const,
    eventId: event.eventId,
    sessionId: event.sessionId,
    seq: event.seq,
    type: event.type,
    entityType: event.entityType,
    entityId: event.entityId,
    occurredAt: event.occurredAt,
    payload: event.entityType === 'log'
      ? publicLogEventPayload(event.payload)
      : publicSessionEventPayload(event.payload),
  };
}
