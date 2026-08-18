import Database from 'better-sqlite3';
import { AppError } from '../errors/app-error';
import {
  PersonalSnapshot,
  PersonalSnapshotLog,
  PersonalSnapshotSession,
  validatePersonalSnapshot,
} from '../personal-snapshot/model';

export type AccountSessionSource = 'collaboration' | 'personal';
export type AccountSessionRole = 'owner' | 'editor' | 'viewer';

interface StoredPersonalSnapshotRow {
  user_id: string;
  revision: number;
  format_version: number;
  snapshot_json: string;
  session_count: number;
  log_count: number;
  byte_size: number;
  checksum: string;
  created_at: string;
  updated_at: string;
}

interface CollaborationCatalogRow {
  session_id: string;
  title: string;
  status: string;
  role: AccountSessionRole;
  owner_user_id: string;
  owner_username: string;
  log_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at: string | null;
}

export interface AccountSessionCatalogQuery {
  page: number;
  pageSize: number;
  q?: string;
  source?: AccountSessionSource;
  status?: string;
  role?: AccountSessionRole;
  includeDeleted: boolean;
}

const CATALOG_QUERY_KEYS = new Set([
  'page',
  'pageSize',
  'q',
  'source',
  'status',
  'role',
  'includeDeleted',
]);
const LOG_QUERY_KEYS = new Set([
  'page',
  'pageSize',
  'q',
  'includeDeleted',
  'sort',
]);

function scalar(
  query: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = query[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a single string`, {
      field,
    });
  }
  return value;
}

function positiveInteger(
  query: Record<string, unknown>,
  field: string,
  fallback: number,
  maximum: number,
): number {
  const value = scalar(query, field);
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a positive integer`, {
      field,
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} is outside the allowed range`, {
      field,
      maximum,
    });
  }
  return parsed;
}

function booleanValue(
  query: Record<string, unknown>,
  field: string,
  fallback = false,
): boolean {
  const value = scalar(query, field);
  if (value === undefined) return fallback;
  if (value !== 'true' && value !== 'false') {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be true or false`, {
      field,
    });
  }
  return value === 'true';
}

function rejectUnknownQuery(query: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(query).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Unknown query parameter', {
      fields: unknown,
    });
  }
}

export function parseAccountSessionCatalogQuery(
  raw: Record<string, unknown>,
): AccountSessionCatalogQuery {
  rejectUnknownQuery(raw, CATALOG_QUERY_KEYS);
  const q = scalar(raw, 'q')?.trim();
  if (q && q.length > 200) {
    throw new AppError(422, 'VALIDATION_FAILED', 'q must be at most 200 characters', {
      field: 'q',
      maximum: 200,
    });
  }
  const source = scalar(raw, 'source');
  if (source !== undefined && source !== 'collaboration' && source !== 'personal') {
    throw new AppError(422, 'VALIDATION_FAILED', 'source is invalid', { field: 'source' });
  }
  const status = scalar(raw, 'status');
  if (
    status !== undefined &&
    !['initializing', 'active', 'closed', 'archived', 'deleted'].includes(status)
  ) {
    throw new AppError(422, 'VALIDATION_FAILED', 'status is invalid', { field: 'status' });
  }
  const role = scalar(raw, 'role');
  if (role !== undefined && !['owner', 'editor', 'viewer'].includes(role)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'role is invalid', { field: 'role' });
  }
  return {
    page: positiveInteger(raw, 'page', 1, 1_000_000),
    pageSize: positiveInteger(raw, 'pageSize', 25, 100),
    ...(q ? { q } : {}),
    ...(source ? { source: source as AccountSessionSource } : {}),
    ...(status ? { status } : {}),
    ...(role ? { role: role as AccountSessionRole } : {}),
    includeDeleted: booleanValue(raw, 'includeDeleted'),
  };
}

export interface AccountSessionCatalogItem {
  source: AccountSessionSource;
  sessionId: string;
  title: string;
  status: string;
  role: AccountSessionRole | null;
  ownerUserId: string;
  ownerUsername: string;
  logCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  deletedAt: string | null;
  snapshotRevision: number | null;
}

export interface PersonalSessionDetail {
  session: PersonalSnapshotSession;
  snapshot: {
    revision: number;
    formatVersion: number;
    sessionCount: number;
    logCount: number;
    byteSize: number;
    checksum: string;
    createdAt: string;
    updatedAt: string;
    exportedAt: string;
  };
  logCount: number;
  deletedLogCount: number;
}

export function personalSessionDto(session: PersonalSnapshotSession) {
  return {
    source: 'personal' as const,
    sessionId: session.session_id,
    title: session.title,
    status: visibleStatus(session.status, session.deleted_at),
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    closedAt: session.closed_at,
    deletedAt: session.deleted_at,
  };
}

export function personalLogDto(log: PersonalSnapshotLog) {
  return {
    syncId: log.sync_id,
    sessionId: log.session_id,
    version: 0,
    time: log.time,
    controller: log.controller,
    callsign: log.callsign,
    rstSent: log.rst_sent,
    rstRcvd: log.rst_rcvd,
    qth: log.qth,
    device: log.device,
    power: log.power,
    antenna: log.antenna,
    height: log.height,
    remarks: log.remarks,
    createdAt: log.created_at,
    updatedAt: log.updated_at,
    createdBy: null,
    updatedBy: null,
    deletedAt: log.deleted_at,
    ownedByCurrentUser: true,
    canMutate: false,
    sourceDeviceId: log.source_device_id,
  };
}

function snapshotCorrupt(cause?: unknown): AppError {
  return new AppError(
    500,
    'PERSONAL_SNAPSHOT_CORRUPT',
    'The stored personal cloud snapshot failed integrity validation',
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

function readStoredSnapshot(
  db: Database.Database,
  userId: string,
): StoredPersonalSnapshotRow | undefined {
  return db.prepare(`
    SELECT * FROM personal_cloud_snapshots WHERE user_id = ?
  `).get(userId) as StoredPersonalSnapshotRow | undefined;
}

function validatedSnapshot(row: StoredPersonalSnapshotRow): PersonalSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.snapshot_json) as unknown;
  } catch (error) {
    throw snapshotCorrupt(error);
  }
  try {
    const validated = validatePersonalSnapshot(parsed);
    if (
      validated.snapshot.version !== Number(row.format_version) ||
      validated.sessionCount !== Number(row.session_count) ||
      validated.logCount !== Number(row.log_count) ||
      validated.byteSize !== Number(row.byte_size) ||
      validated.checksum !== row.checksum
    ) {
      throw snapshotCorrupt();
    }
    return validated.snapshot;
  } catch (error) {
    if (error instanceof AppError && error.code === 'PERSONAL_SNAPSHOT_CORRUPT') {
      throw error;
    }
    throw snapshotCorrupt(error);
  }
}

function visibleStatus(status: string, deletedAt: string | null): string {
  return deletedAt ? 'deleted' : status;
}

function compareCatalogItems(
  left: AccountSessionCatalogItem,
  right: AccountSessionCatalogItem,
): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  if (updated !== 0) return updated;
  const source = left.source.localeCompare(right.source);
  if (source !== 0) return source;
  return left.sessionId.localeCompare(right.sessionId);
}

function matchesQuery(
  item: AccountSessionCatalogItem,
  query: AccountSessionCatalogQuery,
): boolean {
  if (!query.includeDeleted && item.deletedAt) return false;
  if (query.source && item.source !== query.source) return false;
  if (query.status && item.status !== query.status) return false;
  if (query.role && item.role !== query.role) return false;
  const needle = query.q?.trim().toLocaleLowerCase();
  if (!needle) return true;
  return `${item.title}\n${item.sessionId}\n${item.ownerUsername}`
    .toLocaleLowerCase()
    .includes(needle);
}

export function listAccountSessionCatalog(
  db: Database.Database,
  userId: string,
  username: string,
  query: AccountSessionCatalogQuery,
) {
  const collaborationRows = query.source === 'personal'
    ? []
    : db.prepare(`
      SELECT
        s.id AS session_id, s.title, s.status, sm.role,
        s.owner_user_id, owner.username AS owner_username,
        (SELECT COUNT(*) FROM logs l
         WHERE l.session_id = s.id AND l.deleted_at IS NULL) AS log_count,
        s.created_at, s.updated_at, s.closed_at, s.deleted_at
      FROM sessions s
      INNER JOIN session_members sm ON sm.session_id = s.id
      INNER JOIN users owner ON owner.id = s.owner_user_id
      WHERE sm.user_id = ? AND sm.removed_at IS NULL
    `).all(userId) as CollaborationCatalogRow[];

  const items: AccountSessionCatalogItem[] = collaborationRows.map((row) => ({
    source: 'collaboration',
    sessionId: row.session_id,
    title: row.title,
    status: visibleStatus(row.status, row.deleted_at),
    role: row.role,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    logCount: Number(row.log_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    deletedAt: row.deleted_at,
    snapshotRevision: null,
  }));

  if (query.source !== 'collaboration') {
    const stored = readStoredSnapshot(db, userId);
    if (stored) {
      const snapshot = validatedSnapshot(stored);
      const logCounts = new Map<string, number>();
      for (const log of snapshot.logs) {
        if (!log.deleted_at) {
          logCounts.set(log.session_id, (logCounts.get(log.session_id) ?? 0) + 1);
        }
      }
      items.push(...snapshot.sessions.map((session) => ({
        source: 'personal' as const,
        sessionId: session.session_id,
        title: session.title,
        status: visibleStatus(session.status, session.deleted_at),
        role: null,
        ownerUserId: userId,
        ownerUsername: username,
        logCount: logCounts.get(session.session_id) ?? 0,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        closedAt: session.closed_at,
        deletedAt: session.deleted_at,
        snapshotRevision: Number(stored.revision),
      })));
    }
  }

  const filtered = items.filter((item) => matchesQuery(item, query));
  filtered.sort(compareCatalogItems);
  const offset = (query.page - 1) * query.pageSize;
  return {
    items: filtered.slice(offset, offset + query.pageSize),
    page: query.page,
    pageSize: query.pageSize,
    total: filtered.length,
    totalPages: Math.ceil(filtered.length / query.pageSize),
  };
}

function requirePersonalSession(
  db: Database.Database,
  userId: string,
  sessionId: string,
): {
  stored: StoredPersonalSnapshotRow;
  snapshot: PersonalSnapshot;
  session: PersonalSnapshotSession;
} {
  const stored = readStoredSnapshot(db, userId);
  if (!stored) {
    throw new AppError(
      404,
      'PERSONAL_SNAPSHOT_NOT_FOUND',
      'No personal cloud snapshot has been uploaded for this account',
    );
  }
  const snapshot = validatedSnapshot(stored);
  const session = snapshot.sessions.find((candidate) => candidate.session_id === sessionId);
  if (!session) {
    throw new AppError(404, 'PERSONAL_SESSION_NOT_FOUND', 'Personal Session was not found');
  }
  return { stored, snapshot, session };
}

export function getPersonalSessionDetail(
  db: Database.Database,
  userId: string,
  sessionId: string,
): PersonalSessionDetail {
  const { stored, snapshot, session } = requirePersonalSession(db, userId, sessionId);
  const logs = snapshot.logs.filter((log) => log.session_id === sessionId);
  return {
    session,
    snapshot: {
      revision: Number(stored.revision),
      formatVersion: Number(stored.format_version),
      sessionCount: Number(stored.session_count),
      logCount: Number(stored.log_count),
      byteSize: Number(stored.byte_size),
      checksum: stored.checksum,
      createdAt: stored.created_at,
      updatedAt: stored.updated_at,
      exportedAt: snapshot.exportedAt,
    },
    logCount: logs.filter((log) => !log.deleted_at).length,
    deletedLogCount: logs.filter((log) => Boolean(log.deleted_at)).length,
  };
}

export function getPersonalSnapshotSessionLogs(
  db: Database.Database,
  userId: string,
  sessionId: string,
): { session: PersonalSnapshotSession; logs: PersonalSnapshotLog[] } {
  const { snapshot, session } = requirePersonalSession(db, userId, sessionId);
  return { session, logs: snapshot.logs.filter((log) => log.session_id === sessionId) };
}

export function getValidatedPersonalSnapshot(
  db: Database.Database,
  userId: string,
): PersonalSnapshot | undefined {
  const stored = readStoredSnapshot(db, userId);
  return stored && validatedSnapshot(stored);
}

export interface PersonalSessionLogsQuery {
  page: number;
  pageSize: number;
  q?: string;
  includeDeleted: boolean;
  sort: 'timeAsc' | 'timeDesc' | 'updatedDesc';
}

export function parsePersonalSessionLogsQuery(
  raw: Record<string, unknown>,
): PersonalSessionLogsQuery {
  rejectUnknownQuery(raw, LOG_QUERY_KEYS);
  const q = scalar(raw, 'q')?.trim();
  if (q && q.length > 200) {
    throw new AppError(422, 'VALIDATION_FAILED', 'q must be at most 200 characters', {
      field: 'q',
      maximum: 200,
    });
  }
  const sort = scalar(raw, 'sort') ?? 'timeAsc';
  if (!['timeAsc', 'timeDesc', 'updatedDesc'].includes(sort)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'sort is invalid', { field: 'sort' });
  }
  return {
    page: positiveInteger(raw, 'page', 1, 1_000_000),
    pageSize: positiveInteger(raw, 'pageSize', 50, 200),
    ...(q ? { q } : {}),
    includeDeleted: booleanValue(raw, 'includeDeleted'),
    sort: sort as PersonalSessionLogsQuery['sort'],
  };
}

function personalLogSearchText(log: PersonalSnapshotLog): string {
  return [
    log.sync_id,
    log.time,
    log.controller,
    log.callsign,
    log.rst_sent,
    log.rst_rcvd,
    log.qth,
    log.device,
    log.power,
    log.antenna,
    log.height,
    log.remarks,
  ].filter(Boolean).join('\n').toLocaleLowerCase();
}

export function listPersonalSessionLogs(
  db: Database.Database,
  userId: string,
  sessionId: string,
  query: PersonalSessionLogsQuery,
) {
  const { snapshot } = requirePersonalSession(db, userId, sessionId);
  const needle = query.q?.trim().toLocaleLowerCase();
  const logs = snapshot.logs.filter((log) =>
    log.session_id === sessionId &&
    (query.includeDeleted || !log.deleted_at) &&
    (!needle || personalLogSearchText(log).includes(needle)),
  );
  logs.sort((left, right) => {
    if (query.sort === 'updatedDesc') {
      const updated = right.updated_at.localeCompare(left.updated_at);
      return updated || left.sync_id.localeCompare(right.sync_id);
    }
    const time = left.time.localeCompare(right.time);
    const compared = query.sort === 'timeDesc' ? -time : time;
    return compared || left.sync_id.localeCompare(right.sync_id);
  });
  const offset = (query.page - 1) * query.pageSize;
  return {
    items: logs.slice(offset, offset + query.pageSize),
    page: query.page,
    pageSize: query.pageSize,
    total: logs.length,
    totalPages: Math.ceil(logs.length / query.pageSize),
  };
}
