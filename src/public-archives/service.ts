import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { AppError } from '../errors/app-error';
import {
  AccountSessionCatalogQuery,
  AccountSessionCatalogItem,
  getValidatedPersonalSnapshot,
  getPersonalSnapshotSessionLogs,
} from '../session-catalog/account-session-catalog';
import {
  ArchiveActor,
  effectiveSourceAccounts,
  requireArchiveListManager,
  requireArchiveListOwnerOrAdmin,
  requireArchiveSourceAccount,
  requireArchiveSourceSessionVisible,
} from './access';

export interface ArchiveSnapshotInput {
  sourceUserId: string;
  sourceKind: 'personal' | 'collaboration';
  sourceSessionId: string;
}

export interface ArchiveList {
  id: string;
  title: string;
  ownerUserId: string;
  isPublished: boolean;
  displayAlias?: string;
  capabilities: { canManageContents: boolean; canManageAccounts: boolean };
  sessions?: ArchiveSession[];
}

export interface ArchiveSession {
  id: string;
  listId: string;
  sourceUserId: string;
  sourceKind: 'personal' | 'collaboration';
  sourceSessionId: string;
  title: string;
  closedAt: string;
  displayOrder: number;
  logCount: number;
  snapshotAt: string;
}

const listSelect = `SELECT l.id, l.title, l.owner_user_id, l.is_published, a.display_alias, m.user_id AS member_user_id FROM public_archive_lists l LEFT JOIN public_archive_aliases a ON a.list_id = l.id LEFT JOIN public_archive_list_members m ON m.list_id = l.id AND m.user_id = ? WHERE l.id = ? AND l.deleted_at IS NULL`;

function now(): string { return new Date().toISOString(); }

function archiveList(row: { id: string; title: string; owner_user_id: string; is_published: number; display_alias?: string | null; member_user_id?: string | null }, actor: ArchiveActor): ArchiveList {
  const owner = row.owner_user_id === actor.userId;
  return { id: row.id, title: row.title, ownerUserId: row.owner_user_id, isPublished: Boolean(row.is_published), ...(row.display_alias ? { displayAlias: row.display_alias } : {}), capabilities: { canManageContents: owner || isAdmin(actor) || Boolean(row.member_user_id), canManageAccounts: owner || isAdmin(actor) } };
}

function archiveSession(row: Record<string, unknown>): ArchiveSession {
  return {
    id: row.id as string, listId: row.list_id as string, sourceUserId: row.source_user_id as string,
    sourceKind: row.source_kind as ArchiveSession['sourceKind'], sourceSessionId: row.source_session_id as string,
    title: row.title as string, closedAt: row.closed_at as string, displayOrder: Number(row.display_order), logCount: Number(row.log_count), snapshotAt: row.snapshot_at as string,
  };
}

export function createArchiveList(db: Database.Database, actor: ArchiveActor, title: string): ArchiveList {
  const id = randomUUID();
  const timestamp = now();
  db.prepare(`INSERT INTO public_archive_lists (id, title, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, title, actor.userId, timestamp, timestamp);
  return getArchiveList(db, id, actor)!;
}

export function getArchiveList(db: Database.Database, listId: string, actor: ArchiveActor): ArchiveList | undefined {
  try { requireArchiveListManager(db, listId, actor); } catch (error) {
    if (error instanceof AppError && error.status === 404) return undefined;
    throw error;
  }
  const row = db.prepare(listSelect).get(actor.userId, listId) as { id: string; title: string; owner_user_id: string; is_published: number; display_alias?: string | null; member_user_id?: string | null } | undefined;
  if (!row) return undefined;
  const list = archiveList(row, actor);
  list.sessions = (db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM public_archive_list_logs l WHERE l.archive_session_id = s.id) AS log_count FROM public_archive_list_sessions s WHERE s.list_id = ? ORDER BY s.display_order, s.closed_at DESC`).all(listId) as Record<string, unknown>[]).map(archiveSession);
  return list;
}

export function listArchiveLists(db: Database.Database, actor: ArchiveActor): ArchiveList[] {
  const rows = isAdmin(actor)
    ? db.prepare(`SELECT l.id, l.title, l.owner_user_id, l.is_published, a.display_alias, NULL AS member_user_id FROM public_archive_lists l LEFT JOIN public_archive_aliases a ON a.list_id = l.id WHERE l.deleted_at IS NULL ORDER BY l.updated_at DESC`).all()
    : db.prepare(`SELECT l.id, l.title, l.owner_user_id, l.is_published, a.display_alias, m.user_id AS member_user_id FROM public_archive_lists l LEFT JOIN public_archive_aliases a ON a.list_id = l.id LEFT JOIN public_archive_list_members m ON m.list_id = l.id AND m.user_id = ? WHERE l.deleted_at IS NULL AND (l.owner_user_id = ? OR m.user_id IS NOT NULL) ORDER BY l.updated_at DESC`).all(actor.userId, actor.userId);
  return (rows as Array<{ id: string; title: string; owner_user_id: string; is_published: number; display_alias?: string | null; member_user_id?: string | null }>).map((row) => archiveList(row, actor));
}

export function assignArchiveListAlias(
  db: Database.Database,
  listId: string,
  actor: ArchiveActor,
  alias: string,
  displayAlias: string,
): { id: string; title: string; displayAlias: string } {
  return db.transaction(() => {
    requireArchiveListOwnerOrAdmin(db, listId, actor);
    const list = db.prepare(`SELECT id, title FROM public_archive_lists WHERE id = ? AND deleted_at IS NULL`)
      .get(listId) as { id: string; title: string } | undefined;
    if (!list) throw new AppError(404, 'NOT_FOUND', 'Archive list was not found');
    const timestamp = now();
    try {
      db.prepare(`INSERT INTO public_archive_aliases (alias, display_alias, list_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(list_id) DO UPDATE SET alias = excluded.alias, display_alias = excluded.display_alias, created_by = excluded.created_by, updated_at = excluded.updated_at`)
        .run(alias, displayAlias, list.id, actor.userId, timestamp, timestamp);
    } catch (error) {
      if (error instanceof Error && /SQLITE_CONSTRAINT/.test((error as Error & { code?: string }).code ?? '')) {
        throw new AppError(409, 'ARCHIVE_ALIAS_TAKEN', 'Archive alias is already taken');
      }
      throw error;
    }
    return { ...list, displayAlias };
  })();
}

export function updateArchiveListTitle(
  db: Database.Database,
  listId: string,
  actor: ArchiveActor,
  title: string,
): ArchiveList {
  requireArchiveListManager(db, listId, actor);
  db.prepare(`UPDATE public_archive_lists SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(title, now(), listId);
  return getArchiveList(db, listId, actor)!;
}

function isAdmin(actor: ArchiveActor) { return actor.role === 'admin'; }

function requireActiveUser(db: Database.Database, userId: string): void {
  const user = db.prepare(`SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL AND deleted_at IS NULL`).get(userId);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'An active target user is required');
}

function touchArchiveList(db: Database.Database, listId: string, timestamp: string): void {
  db.prepare(`UPDATE public_archive_lists SET updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(timestamp, listId);
}

export function addArchiveMember(db: Database.Database, listId: string, actor: ArchiveActor, userId: string): void {
  db.transaction(() => {
    requireArchiveListOwnerOrAdmin(db, listId, actor);
    requireActiveUser(db, userId);
    const timestamp = now();
    const result = db.prepare(`INSERT OR IGNORE INTO public_archive_list_members (list_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)`)
      .run(listId, userId, actor.userId, timestamp);
    if (result.changes) touchArchiveList(db, listId, timestamp);
  })();
}

export function removeArchiveMember(db: Database.Database, listId: string, actor: ArchiveActor, userId: string): void {
  db.transaction(() => {
    requireArchiveListOwnerOrAdmin(db, listId, actor);
    const timestamp = now();
    if (db.prepare(`DELETE FROM public_archive_list_members WHERE list_id = ? AND user_id = ?`).run(listId, userId).changes) {
      touchArchiveList(db, listId, timestamp);
    }
  })();
}

export function addArchiveSource(db: Database.Database, listId: string, actor: ArchiveActor, userId: string): void {
  db.transaction(() => {
    requireArchiveListOwnerOrAdmin(db, listId, actor);
    requireActiveUser(db, userId);
    const timestamp = now();
    const result = db.prepare(`INSERT OR IGNORE INTO public_archive_list_sources (list_id, user_id, authorized_by, created_at) VALUES (?, ?, ?, ?)`)
      .run(listId, userId, actor.userId, timestamp);
    if (result.changes) touchArchiveList(db, listId, timestamp);
  })();
}

export function removeArchiveSource(db: Database.Database, listId: string, actor: ArchiveActor, userId: string): void {
  db.transaction(() => {
    requireArchiveListOwnerOrAdmin(db, listId, actor);
    const timestamp = now();
    if (db.prepare(`DELETE FROM public_archive_list_sources WHERE list_id = ? AND user_id = ?`).run(listId, userId).changes) {
      touchArchiveList(db, listId, timestamp);
    }
  })();
}

export function listAvailableArchiveSessions(db: Database.Database, listId: string, actor: ArchiveActor, query: AccountSessionCatalogQuery) {
  requireArchiveListManager(db, listId, actor);
  const allowed = effectiveSourceAccounts(db, listId);
  const users = db.prepare(`SELECT id, username FROM users WHERE id IN (${[...allowed].map(() => '?').join(', ')})`).all(...allowed) as Array<{ id: string; username: string }>;
  const items: AccountSessionCatalogItem[] = [];
  for (const user of users) {
    if (actor.role === 'admin' || actor.userId === user.id) {
      const personal = getValidatedPersonalSnapshot(db, user.id);
      if (personal) {
        for (const source of personal.sessions) {
          if (source.status === 'closed' && !source.deleted_at) {
            items.push({ source: 'personal', sessionId: source.session_id, title: source.title, status: source.status, role: null, ownerUserId: user.id, ownerUsername: user.username, logCount: personal.logs.filter((log) => log.session_id === source.session_id && !log.deleted_at).length, createdAt: source.created_at, updatedAt: source.updated_at, closedAt: source.closed_at, deletedAt: source.deleted_at, snapshotRevision: null });
          }
        }
      }
    }
    const rows = actor.role === 'admin'
      ? db.prepare(`SELECT s.id, s.title, s.status, s.created_at, s.updated_at, s.closed_at, s.deleted_at, (SELECT COUNT(*) FROM logs l WHERE l.session_id = s.id AND l.deleted_at IS NULL) AS log_count FROM sessions s WHERE s.owner_user_id = ?`).all(user.id)
      : db.prepare(`SELECT s.id, s.title, s.status, s.created_at, s.updated_at, s.closed_at, s.deleted_at, sm.role, (SELECT COUNT(*) FROM logs l WHERE l.session_id = s.id AND l.deleted_at IS NULL) AS log_count FROM sessions s INNER JOIN session_members sm ON sm.session_id = s.id AND sm.user_id = ? AND sm.removed_at IS NULL WHERE s.owner_user_id = ?`).all(actor.userId, user.id);
    for (const row of rows as Array<Record<string, unknown>>) {
      if (row.status === 'closed' && !row.deleted_at) items.push({ source: 'collaboration', sessionId: row.id as string, title: row.title as string, status: 'closed', role: (row.role as AccountSessionCatalogItem['role']) ?? null, ownerUserId: user.id, ownerUsername: user.username, logCount: Number(row.log_count), createdAt: row.created_at as string, updatedAt: row.updated_at as string, closedAt: row.closed_at as string | null, deletedAt: null, snapshotRevision: null });
    }
  }
  const needle = query.q?.toLocaleLowerCase();
  const filtered = items.filter((item) =>
    (!query.source || item.source === query.source) &&
    (!needle || `${item.title}\n${item.sessionId}\n${item.ownerUsername}`.toLocaleLowerCase().includes(needle)),
  );
  filtered.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.source.localeCompare(right.source) || left.sessionId.localeCompare(right.sessionId));
  const offset = (query.page - 1) * query.pageSize;
  return { items: filtered.slice(offset, offset + query.pageSize), page: query.page, pageSize: query.pageSize, total: filtered.length, totalPages: Math.ceil(filtered.length / query.pageSize) };
}

type SourceLog = { sync_id: string; time: string; controller: string; callsign: string; rst_sent: string | null; rst_rcvd: string | null; qth: string | null; device: string | null; power: string | null; antenna: string | null; height: string | null; remarks: string | null; deleted_at: string | null };
type SourceSession = { title: string; created_at: string; closed_at: string | null; status: string; deleted_at: string | null; logs: SourceLog[] };

function sourceSession(db: Database.Database, input: ArchiveSnapshotInput): SourceSession {
  if (input.sourceKind === 'personal') {
    const detail = getPersonalSnapshotSessionLogs(db, input.sourceUserId, input.sourceSessionId);
    return { ...detail.session, logs: detail.logs };
  }
  const session = db.prepare(`SELECT title, created_at, closed_at, status, deleted_at FROM sessions WHERE id = ? AND owner_user_id = ?`)
    .get(input.sourceSessionId, input.sourceUserId) as Omit<SourceSession, 'logs'> | undefined;
  if (!session) throw new AppError(422, 'ARCHIVE_SESSION_NOT_CLOSED', 'Archive source session is not closed');
  const logs = db.prepare(`SELECT sync_id, time, controller, callsign, rst_sent, rst_rcvd, qth, device, power, antenna, height, remarks, deleted_at FROM logs WHERE session_id = ?`).all(input.sourceSessionId) as SourceLog[];
  return { ...session, logs };
}

function validateClosed(session: SourceSession): void {
  if (session.status !== 'closed' || session.deleted_at || !session.closed_at) {
    throw new AppError(422, 'ARCHIVE_SESSION_NOT_CLOSED', 'Archive source session is not closed');
  }
}

function snapshot(db: Database.Database, listId: string, actor: ArchiveActor, input?: ArchiveSnapshotInput, existingId?: string): ArchiveSession {
  return db.transaction(() => {
    requireArchiveListManager(db, listId, actor);
    const refreshRow = existingId
      ? db.prepare(`SELECT * FROM public_archive_list_sessions WHERE id = ? AND list_id = ?`).get(existingId, listId) as Record<string, unknown> | undefined
      : undefined;
    if (existingId && !refreshRow) throw new AppError(404, 'NOT_FOUND', 'Archive session was not found');
    const sourceInput = input ?? {
      sourceUserId: refreshRow!.source_user_id as string,
      sourceKind: refreshRow!.source_kind as ArchiveSnapshotInput['sourceKind'],
      sourceSessionId: refreshRow!.source_session_id as string,
    };
    requireArchiveSourceAccount(db, listId, sourceInput.sourceUserId);
    requireArchiveSourceSessionVisible(db, actor, sourceInput.sourceUserId, sourceInput.sourceKind, sourceInput.sourceSessionId);
    const source = sourceSession(db, sourceInput);
    validateClosed(source);
    const existing = existingId
      ? refreshRow
      : db.prepare(`SELECT * FROM public_archive_list_sessions WHERE list_id = ? AND source_user_id = ? AND source_kind = ? AND source_session_id = ?`).get(listId, sourceInput.sourceUserId, sourceInput.sourceKind, sourceInput.sourceSessionId) as Record<string, unknown> | undefined;
    if (existing && !existingId) throw new AppError(409, 'ARCHIVE_SESSION_ALREADY_ADDED', 'Archive session is already added');
    if (!existing && existingId) throw new AppError(404, 'NOT_FOUND', 'Archive session was not found');
    const timestamp = now();
    const id = existingId ?? randomUUID();
    const displayOrder = existing ? Number(existing.display_order) : Number(db.prepare(`SELECT COUNT(*) FROM public_archive_list_sessions WHERE list_id = ?`).pluck().get(listId));
    if (existing) {
      db.prepare(`UPDATE public_archive_list_sessions SET title = ?, closed_at = ?, source_created_at = ?, snapshot_at = ?, updated_at = ? WHERE id = ?`)
        .run(source.title, source.closed_at, source.created_at, timestamp, timestamp, id);
      db.prepare(`DELETE FROM public_archive_list_logs WHERE archive_session_id = ?`).run(id);
    } else {
      db.prepare(`INSERT INTO public_archive_list_sessions (id, list_id, source_user_id, source_kind, source_session_id, title, status, closed_at, source_created_at, snapshot_at, display_order, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, listId, sourceInput.sourceUserId, sourceInput.sourceKind, sourceInput.sourceSessionId, source.title, source.closed_at, source.created_at, timestamp, displayOrder, actor.userId, timestamp, timestamp);
    }
    const insert = db.prepare(`INSERT INTO public_archive_list_logs (archive_session_id, source_sync_id, ordinal, time, controller, callsign, rst_sent, rst_rcvd, qth, device, power, antenna, height, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    source.logs.filter((log) => !log.deleted_at).sort((left, right) => left.time.localeCompare(right.time) || left.sync_id.localeCompare(right.sync_id)).forEach((log, index) => insert.run(id, log.sync_id, index + 1, log.time, log.controller, log.callsign, log.rst_sent, log.rst_rcvd, log.qth, log.device, log.power, log.antenna, log.height, log.remarks));
    touchArchiveList(db, listId, timestamp);
    return archiveSession(db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM public_archive_list_logs WHERE archive_session_id = s.id) AS log_count
      FROM public_archive_list_sessions s
      WHERE s.id = ?
    `).get(id) as Record<string, unknown>);
  })();
}

export function createArchiveSnapshot(db: Database.Database, listId: string, actor: ArchiveActor, input: ArchiveSnapshotInput): ArchiveSession { return snapshot(db, listId, actor, input); }

export function refreshArchiveSnapshot(db: Database.Database, listId: string, archiveSessionId: string, actor: ArchiveActor): ArchiveSession {
  return snapshot(db, listId, actor, undefined, archiveSessionId);
}

export function reorderArchiveSessions(db: Database.Database, listId: string, actor: ArchiveActor, archiveSessionIds: string[]): void {
  db.transaction(() => {
    requireArchiveListManager(db, listId, actor);
    const existing = db.prepare(`SELECT id FROM public_archive_list_sessions WHERE list_id = ?`)
      .all(listId) as Array<{ id: string }>;
    const existingIds = new Set(existing.map((row) => row.id));
    if (
      new Set(archiveSessionIds).size !== archiveSessionIds.length ||
      existingIds.size !== archiveSessionIds.length ||
      archiveSessionIds.some((id) => !existingIds.has(id))
    ) {
      throw new AppError(422, 'VALIDATION_FAILED', 'Archive session order is invalid');
    }
    const timestamp = now();
    const update = db.prepare(`UPDATE public_archive_list_sessions SET display_order = ?, updated_at = ? WHERE id = ? AND list_id = ?`);
    archiveSessionIds.forEach((id, index) => update.run(index, timestamp, id, listId));
    touchArchiveList(db, listId, timestamp);
  })();
}

export function removeArchiveSession(db: Database.Database, listId: string, archiveSessionId: string, actor: ArchiveActor): void {
  requireArchiveListManager(db, listId, actor);
  db.transaction(() => {
    const exists = db.prepare(`SELECT 1 FROM public_archive_list_sessions WHERE id = ? AND list_id = ?`).get(archiveSessionId, listId);
    if (!exists) throw new AppError(404, 'NOT_FOUND', 'Archive session was not found');
    const timestamp = now();
    db.prepare(`DELETE FROM public_archive_list_logs WHERE archive_session_id = ?`).run(archiveSessionId);
    db.prepare(`DELETE FROM public_archive_list_sessions WHERE id = ?`).run(archiveSessionId);
    const rows = db.prepare(`SELECT id FROM public_archive_list_sessions WHERE list_id = ? ORDER BY display_order, closed_at DESC`).all(listId) as Array<{ id: string }>;
    rows.forEach((row, index) => db.prepare(`UPDATE public_archive_list_sessions SET display_order = ? WHERE id = ?`).run(index, row.id));
    touchArchiveList(db, listId, timestamp);
  })();
}

function updatePublication(db: Database.Database, listId: string, actor: ArchiveActor, published: boolean): void { requireArchiveListManager(db, listId, actor); const timestamp = now(); db.prepare(`UPDATE public_archive_lists SET is_published = ?, unpublished_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(published ? 1 : 0, published ? null : timestamp, timestamp, listId); }
export function publishArchiveList(db: Database.Database, listId: string, actor: ArchiveActor): void { updatePublication(db, listId, actor, true); }
export function unpublishArchiveList(db: Database.Database, listId: string, actor: ArchiveActor): void { updatePublication(db, listId, actor, false); }
export function softDeleteArchiveList(db: Database.Database, listId: string, actor: ArchiveActor): void { requireArchiveListManager(db, listId, actor); const timestamp = now(); db.prepare(`UPDATE public_archive_lists SET is_published = 0, unpublished_at = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(timestamp, timestamp, timestamp, listId); }
