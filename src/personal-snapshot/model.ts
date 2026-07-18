import { createHash } from 'crypto';
import { AppError } from '../errors/app-error';
import { rejectUnknownKeys, requireJsonObject } from '../utils/validation';

export const PERSONAL_SNAPSHOT_FORMAT_VERSION = 1;
export const PERSONAL_SNAPSHOT_REPLACE_CONFIRMATION =
  'REPLACE_PERSONAL_CLOUD_SNAPSHOT';
export const MAX_PERSONAL_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_PERSONAL_SNAPSHOT_SESSIONS = 5_000;
export const MAX_PERSONAL_SNAPSHOT_LOGS = 100_000;

export interface PersonalSnapshotSession {
  session_id: string;
  title: string;
  status: 'active' | 'closed' | 'archived';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at: string | null;
}

export interface PersonalSnapshotLog {
  sync_id: string;
  session_id: string;
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
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  source_device_id: string | null;
}

export interface PersonalSnapshot {
  version: 1;
  exportedAt: string;
  sessions: PersonalSnapshotSession[];
  logs: PersonalSnapshotLog[];
}

export interface ValidatedPersonalSnapshot {
  snapshot: PersonalSnapshot;
  serialized: string;
  byteSize: number;
  sessionCount: number;
  logCount: number;
  checksum: string;
}

const SNAPSHOT_KEYS = ['version', 'exportedAt', 'sessions', 'logs'] as const;
const SESSION_KEYS = [
  'session_id',
  'title',
  'status',
  'created_at',
  'updated_at',
  'closed_at',
  'deleted_at',
] as const;
const LOG_KEYS = [
  'sync_id',
  'session_id',
  'time',
  'controller',
  'callsign',
  'rst_sent',
  'rst_rcvd',
  'qth',
  'device',
  'power',
  'antenna',
  'height',
  'remarks',
  'created_at',
  'updated_at',
  'deleted_at',
  'source_device_id',
] as const;

function validationError(message: string, field: string, details: object = {}): never {
  throw new AppError(422, 'VALIDATION_FAILED', message, { field, ...details });
}

function exactString(
  value: Record<string, unknown>,
  field: string,
  path: string,
  maximum: number,
  minimum = 0,
): string {
  const raw = value[field];
  if (typeof raw !== 'string') {
    validationError(`${path} must be a string`, path);
  }
  if (raw.length < minimum || raw.length > maximum) {
    validationError(`${path} length is outside the allowed range`, path, {
      minimum,
      maximum,
    });
  }
  return raw;
}

function nullableExactString(
  value: Record<string, unknown>,
  field: string,
  path: string,
  maximum: number,
  minimum = 0,
): string | null {
  const raw = value[field];
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    validationError(`${path} must be a string or null`, path);
  }
  if (raw.length < minimum || raw.length > maximum) {
    validationError(`${path} length is outside the allowed range`, path, {
      minimum,
      maximum,
    });
  }
  return raw;
}

function stableId(
  value: Record<string, unknown>,
  field: string,
  path: string,
): string {
  const id = exactString(value, field, path, 128, 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    validationError(`${path} is not a valid stable identifier`, path);
  }
  return id;
}

function calendarMonthLength(year: number, month: number): number {
  if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31;
  if ([4, 6, 9, 11].includes(month)) return 30;
  if (month !== 2) return 0;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return leapYear ? 29 : 28;
}

function timestamp(
  value: Record<string, unknown>,
  field: string,
  path: string,
): string {
  const raw = exactString(value, field, path, 64, 1);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
    raw,
  );
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = calendarMonthLength(year, month);
  if (
    !match ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    validationError(`${path} must be an RFC 3339 timestamp`, path);
  }
  return raw;
}

function nullableTimestamp(
  value: Record<string, unknown>,
  field: string,
  path: string,
): string | null {
  if (value[field] === null) return null;
  return timestamp(value, field, path);
}

function logTime(
  value: Record<string, unknown>,
  field: string,
  path: string,
): string {
  const raw = exactString(value, field, path, 64, 1);
  if (/^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw)) {
    return raw;
  }
  return timestamp(value, field, path);
}

function arrayField(
  value: Record<string, unknown>,
  field: string,
  maximum: number,
): unknown[] {
  const raw = value[field];
  if (!Array.isArray(raw)) validationError(`${field} must be an array`, field);
  if (raw.length > maximum) {
    throw new AppError(413, 'PERSONAL_SNAPSHOT_TOO_LARGE', `${field} exceeds the item limit`, {
      field,
      maximum,
      actual: raw.length,
    });
  }
  return raw;
}

function parseSession(value: unknown, index: number): PersonalSnapshotSession {
  const path = `sessions[${index}]`;
  const row = requireJsonObject(value);
  rejectUnknownKeys(row, SESSION_KEYS);
  const status = exactString(row, 'status', `${path}.status`, 16, 1);
  if (status !== 'active' && status !== 'closed' && status !== 'archived') {
    validationError(
      `${path}.status must be active, closed, or archived`,
      `${path}.status`,
    );
  }
  const closedAt = nullableTimestamp(row, 'closed_at', `${path}.closed_at`);
  return {
    session_id: stableId(row, 'session_id', `${path}.session_id`),
    title: exactString(row, 'title', `${path}.title`, 500, 1),
    status,
    created_at: timestamp(row, 'created_at', `${path}.created_at`),
    updated_at: timestamp(row, 'updated_at', `${path}.updated_at`),
    closed_at: closedAt,
    deleted_at: nullableTimestamp(row, 'deleted_at', `${path}.deleted_at`),
  };
}

function parseLog(value: unknown, index: number): PersonalSnapshotLog {
  const path = `logs[${index}]`;
  const row = requireJsonObject(value);
  rejectUnknownKeys(row, LOG_KEYS);
  return {
    sync_id: stableId(row, 'sync_id', `${path}.sync_id`),
    session_id: stableId(row, 'session_id', `${path}.session_id`),
    time: logTime(row, 'time', `${path}.time`),
    controller: exactString(row, 'controller', `${path}.controller`, 32, 1),
    callsign: exactString(row, 'callsign', `${path}.callsign`, 32, 1),
    rst_sent: nullableExactString(row, 'rst_sent', `${path}.rst_sent`, 16),
    rst_rcvd: nullableExactString(row, 'rst_rcvd', `${path}.rst_rcvd`, 16),
    qth: nullableExactString(row, 'qth', `${path}.qth`, 200),
    device: nullableExactString(row, 'device', `${path}.device`, 200),
    power: nullableExactString(row, 'power', `${path}.power`, 64),
    antenna: nullableExactString(row, 'antenna', `${path}.antenna`, 200),
    height: nullableExactString(row, 'height', `${path}.height`, 64),
    remarks: nullableExactString(row, 'remarks', `${path}.remarks`, 2_000),
    created_at: timestamp(row, 'created_at', `${path}.created_at`),
    updated_at: timestamp(row, 'updated_at', `${path}.updated_at`),
    deleted_at: nullableTimestamp(row, 'deleted_at', `${path}.deleted_at`),
    source_device_id: nullableExactString(
      row,
      'source_device_id',
      `${path}.source_device_id`,
      128,
      1,
    ),
  };
}

function contentChecksum(snapshot: PersonalSnapshot): string {
  const compareStableId = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  const sessions = [...snapshot.sessions].sort((left, right) =>
    compareStableId(left.session_id, right.session_id));
  const logs = [...snapshot.logs].sort((left, right) =>
    compareStableId(left.sync_id, right.sync_id));
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => compareStableId(left, right))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({
      version: snapshot.version,
      sessions,
      logs,
    })))
    .digest('hex');
}

export function validatePersonalSnapshot(value: unknown): ValidatedPersonalSnapshot {
  const root = requireJsonObject(value);
  rejectUnknownKeys(root, SNAPSHOT_KEYS);
  if (root.version !== PERSONAL_SNAPSHOT_FORMAT_VERSION) {
    validationError('snapshot.version must be 1', 'snapshot.version', {
      supportedVersion: PERSONAL_SNAPSHOT_FORMAT_VERSION,
    });
  }
  const sessionRows = arrayField(
    root,
    'sessions',
    MAX_PERSONAL_SNAPSHOT_SESSIONS,
  );
  const logRows = arrayField(root, 'logs', MAX_PERSONAL_SNAPSHOT_LOGS);
  const sessions = sessionRows.map(parseSession);
  const logs = logRows.map(parseLog);
  const sessionIds = new Set<string>();
  for (let index = 0; index < sessions.length; index += 1) {
    const id = sessions[index].session_id;
    if (sessionIds.has(id)) {
      validationError('Session IDs must be unique', `sessions[${index}].session_id`, { id });
    }
    sessionIds.add(id);
  }
  const logIds = new Set<string>();
  for (let index = 0; index < logs.length; index += 1) {
    const log = logs[index];
    if (!sessionIds.has(log.session_id)) {
      validationError(
        'Every Log must reference a Session in the same snapshot',
        `logs[${index}].session_id`,
        { sessionId: log.session_id },
      );
    }
    if (logIds.has(log.sync_id)) {
      validationError(
        'Log sync IDs must be globally unique',
        `logs[${index}].sync_id`,
        { sessionId: log.session_id, syncId: log.sync_id },
      );
    }
    logIds.add(log.sync_id);
  }
  const snapshot: PersonalSnapshot = {
    version: PERSONAL_SNAPSHOT_FORMAT_VERSION,
    exportedAt: timestamp(root, 'exportedAt', 'snapshot.exportedAt'),
    sessions,
    logs,
  };
  const serialized = JSON.stringify(snapshot);
  const byteSize = Buffer.byteLength(serialized, 'utf8');
  if (byteSize > MAX_PERSONAL_SNAPSHOT_BYTES) {
    throw new AppError(
      413,
      'PERSONAL_SNAPSHOT_TOO_LARGE',
      'The personal snapshot exceeds the byte limit',
      { maximum: MAX_PERSONAL_SNAPSHOT_BYTES, actual: byteSize },
    );
  }
  return {
    snapshot,
    serialized,
    byteSize,
    sessionCount: sessions.length,
    logCount: logs.length,
    checksum: contentChecksum(snapshot),
  };
}
