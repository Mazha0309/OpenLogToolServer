import type { PublicEvent, PublicLog, PublicSession } from './types';

type JsonRecord = Record<string, unknown>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: string,
    retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${label} is not an object`);
  }
  return value as JsonRecord;
}

function string(value: JsonRecord, field: string): string {
  if (typeof value[field] !== 'string') throw new ProtocolError(`${field} is not a string`);
  return value[field];
}

function nullableString(value: JsonRecord, field: string): string | null {
  if (value[field] !== null && typeof value[field] !== 'string') {
    throw new ProtocolError(`${field} is not nullable text`);
  }
  return value[field] as string | null;
}

function sequence(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ProtocolError(`${field} is not a sequence`);
  }
  return Number(value);
}

export function parsePublicSession(value: unknown): PublicSession {
  const source = record(value, 'session');
  return {
    sessionId: string(source, 'sessionId'),
    title: string(source, 'title'),
    status: string(source, 'status'),
    closedAt: nullableString(source, 'closedAt'),
    deletedAt: nullableString(source, 'deletedAt'),
  };
}

export function parsePublicLog(value: unknown): PublicLog {
  const source = record(value, 'log');
  return {
    syncId: string(source, 'syncId'),
    time: string(source, 'time'),
    controller: string(source, 'controller'),
    callsign: string(source, 'callsign'),
    rstSent: nullableString(source, 'rstSent'),
    rstRcvd: nullableString(source, 'rstRcvd'),
    qth: nullableString(source, 'qth'),
    device: nullableString(source, 'device'),
    power: nullableString(source, 'power'),
    antenna: nullableString(source, 'antenna'),
    height: nullableString(source, 'height'),
    remarks: nullableString(source, 'remarks'),
    deletedAt: nullableString(source, 'deletedAt'),
  };
}

export function parsePublicEvent(value: unknown): PublicEvent {
  const source = record(value, 'event');
  if (source.protocolVersion !== 1) throw new ProtocolError('Unsupported event protocol');
  const entityType = source.entityType;
  if (entityType !== 'session' && entityType !== 'log') {
    throw new ProtocolError('Unsupported event entity type');
  }
  return {
    protocolVersion: 1,
    eventId: string(source, 'eventId'),
    sessionId: string(source, 'sessionId'),
    seq: sequence(source.seq, 'seq'),
    type: string(source, 'type'),
    entityType,
    entityId: string(source, 'entityId'),
    occurredAt: string(source, 'occurredAt'),
    payload: entityType === 'log'
      ? parsePublicLog(source.payload)
      : parsePublicSession(source.payload),
  };
}

async function requestJson(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<JsonRecord> {
  const response = await fetch(path, {
    ...init,
    signal,
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    const root = record(body, 'error response');
    const error = root.error && typeof root.error === 'object' && !Array.isArray(root.error)
      ? root.error as JsonRecord
      : {};
    const code = typeof error.code === 'string' ? error.code : `HTTP_${response.status}`;
    const retryAfter = response.headers.get('Retry-After');
    const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter)
      ? Number(retryAfter)
      : undefined;
    throw new ApiError(response.status, code, retryAfterSeconds);
  }
  return record(body, 'response');
}

export async function getServerInfo(signal: AbortSignal): Promise<{
  protocolMin: number;
  protocolMax: number;
  features: string[];
}> {
  const body = await requestJson('/api/v1/server-info', { method: 'GET' }, signal);
  if (!Number.isInteger(body.protocolMin) || !Number.isInteger(body.protocolMax)) {
    throw new ProtocolError('Server protocol range is invalid');
  }
  if (!Array.isArray(body.features) || body.features.some((item) => typeof item !== 'string')) {
    throw new ProtocolError('Server features are invalid');
  }
  return {
    protocolMin: Number(body.protocolMin),
    protocolMax: Number(body.protocolMax),
    features: body.features as string[],
  };
}

export async function exchangePublicShare(
  publicShareId: string,
  secret: string,
  viewSessionId: string,
  signal: AbortSignal,
): Promise<{
  accessToken: string;
  expiresAt: string;
  sessionId: string;
  shareExpiresAt: string;
}> {
  const body = await requestJson(
    `/api/v1/public-shares/${encodeURIComponent(publicShareId)}/exchange`,
    { method: 'POST', body: JSON.stringify({ secret, viewSessionId }) },
    signal,
  );
  const share = record(body.publicShare, 'publicShare');
  if (string(share, 'publicShareId') !== publicShareId) {
    throw new ProtocolError('Public share identity changed');
  }
  return {
    accessToken: string(body, 'accessToken'),
    expiresAt: string(body, 'expiresAt'),
    sessionId: string(share, 'sessionId'),
    shareExpiresAt: string(share, 'expiresAt'),
  };
}

export async function getPublicSnapshot(
  sessionId: string,
  accessToken: string,
  signal: AbortSignal,
): Promise<{
  session: PublicSession;
  highWatermarkSeq: number;
  logs: PublicLog[];
}> {
  const body = await requestJson(
    `/api/v1/public/sessions/${encodeURIComponent(sessionId)}/snapshot`,
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
    signal,
  );
  if (body.protocolVersion !== 1) throw new ProtocolError('Unsupported snapshot protocol');
  if (!Array.isArray(body.logs)) throw new ProtocolError('Snapshot logs are invalid');
  const session = parsePublicSession(body.session);
  if (session.sessionId !== sessionId) throw new ProtocolError('Snapshot Session changed');
  return {
    session,
    highWatermarkSeq: sequence(body.highWatermarkSeq, 'highWatermarkSeq'),
    logs: body.logs.map(parsePublicLog).filter((log) => log.deletedAt === null),
  };
}

export async function getPublicWsTicket(
  sessionId: string,
  accessToken: string,
  afterSeq: number,
  signal: AbortSignal,
): Promise<string> {
  const body = await requestJson(
    `/api/v1/public/sessions/${encodeURIComponent(sessionId)}/ws-ticket`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ afterSeq }),
    },
    signal,
  );
  if (sequence(body.afterSeq, 'afterSeq') !== afterSeq || string(body, 'sessionId') !== sessionId) {
    throw new ProtocolError('WebSocket ticket scope changed');
  }
  return string(body, 'ticket');
}
