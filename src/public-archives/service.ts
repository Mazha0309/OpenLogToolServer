import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { AppError } from '../errors/app-error';
import {
  AccountSessionCatalogQuery,
  getPersonalSnapshotSessionLogs,
  listAccountSessionCatalog,
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
}

const listSelect = `SELECT id, title, owner_user_id, is_published FROM public_archive_lists WHERE id = ? AND deleted_at IS NULL`;

function now(): string { return new Date().toISOString(); }

function archiveList(row: { id: string; title: string; owner_user_id: string; is_published: number }): ArchiveList {
  return { id: row.id, title: row.title, ownerUserId: row.owner_user_id, isPublished: Boolean(row.is_published) };
}

function archiveSession(row: Record<string, unknown>): ArchiveSession {
  return {
    id: row.id as string, listId: row.list_id as string, sourceUserId: row.source_user_id as string,
    sourceKind: row.source_kind as ArchiveSession['sourceKind'], sourceSessionId: row.source_session_id as string,
    title: row.title as string, closedAt: row.closed_at as string, displayOrder: Number(row.display_order),
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
  const row = db.prepare(listSelect).get(listId) as { id: string; title: string; owner_user_id: string; is_published: number } | undefined;
  return row && archiveList(row);
}

export function listArchiveLists(db: Database.Database, actor: ArchiveActor): ArchiveList[] {
  const rows = isAdmin(actor)
    ? db.prepare(`SELECT id, title, owner_user_id, is_published FROM public_archive_lists WHERE deleted_at IS NULL ORDER BY updated_at DESC`).all()
    : db.prepare(`SELECT l.id, l.title, l.owner_user_id, l.is_published FROM public_archive_lists l LEFT JOIN public_archive_list_members m ON m.list_id = l.id AND m.user_id = ? WHERE l.deleted_at IS NULL AND (l.owner_user_id = ? OR m.user_id IS NOT NULL) ORDER BY l.updated_at DESC`).all(actor.userId, actor.userId);
  return (rows as Array<{ id: string; title: string; owner_user_id: string; is_published: number }>).map(archiveList);
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

export function addArchiveMember(db: Database.Database, listId: string, actor: ArchiveActor, userId: string): void {
  requireArchiveListOwnerOrAdmin(db, listId, actor);
  db.prepare(`INSERT OR IGNORE INTO public_archive_list_members (list_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)`)
    .run(listId, userId, actor.userId, now());
}

export function removeArchiveMember(db: Database.Database, listId: string, actor: ArchiveActor, userId: string): void {
  requireArchiveListOwnerOrAdmin(db, listId, actor);
  db.prepare(`DELETE FROM public_archive_list_members WHERE list_id = ? AND user_id = ?`).run(listId, userId);
}

export function addArchiveSource(db: Database.Database, listId: string, actor: ArchiveActor, userId: string): void {
  requireArchiveListOwnerOrAdmin(db, listId, actor);
  db.prepare(`INSERT OR IGNORE INTO public_archive_list_sources (list_id, user_id, authorized_by, created_at) VALUES (?, ?, ?, ?)`)
    .run(listId, userId, actor.userId, now());
}

export function removeArchiveSource(db: Database.Database, listId: string, actor: ArchiveActor, userId: string): void {
  requireArchiveListOwnerOrAdmin(db, listId, actor);
  db.prepare(`DELETE FROM public_archive_list_sources WHERE list_id = ? AND user_id = ?`).run(listId, userId);
}

export function listAvailableArchiveSessions(db: Database.Database, listId: string, actor: ArchiveActor, query: AccountSessionCatalogQuery) {
  requireArchiveListManager(db, listId, actor);
  const allowed = effectiveSourceAccounts(db, listId);
  const catalog = listAccountSessionCatalog(db, actor.userId, actor.userId, query);
  return { ...catalog, items: catalog.items.filter((item) => allowed.has(item.ownerUserId) && item.status === 'closed' && !item.deletedAt) };
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

function snapshot(db: Database.Database, listId: string, actor: ArchiveActor, input: ArchiveSnapshotInput, existingId?: string): ArchiveSession {
  requireArchiveListManager(db, listId, actor);
  requireArchiveSourceAccount(db, listId, input.sourceUserId);
  requireArchiveSourceSessionVisible(db, actor, input.sourceUserId, input.sourceKind, input.sourceSessionId);
  const source = sourceSession(db, input);
  validateClosed(source);
  const existing = existingId
    ? db.prepare(`SELECT * FROM public_archive_list_sessions WHERE id = ? AND list_id = ?`).get(existingId, listId) as Record<string, unknown> | undefined
    : db.prepare(`SELECT * FROM public_archive_list_sessions WHERE list_id = ? AND source_user_id = ? AND source_kind = ? AND source_session_id = ?`).get(listId, input.sourceUserId, input.sourceKind, input.sourceSessionId) as Record<string, unknown> | undefined;
  if (existing && !existingId) throw new AppError(409, 'ARCHIVE_SESSION_ALREADY_ADDED', 'Archive session is already added');
  if (!existing && existingId) throw new AppError(404, 'NOT_FOUND', 'Archive session was not found');
  const timestamp = now();
  const id = existingId ?? randomUUID();
  const displayOrder = existing ? Number(existing.display_order) : Number(db.prepare(`SELECT COUNT(*) FROM public_archive_list_sessions WHERE list_id = ?`).pluck().get(listId));
  const write = db.transaction(() => {
    if (existing) {
      db.prepare(`UPDATE public_archive_list_sessions SET title = ?, closed_at = ?, source_created_at = ?, snapshot_at = ?, updated_at = ? WHERE id = ?`)
        .run(source.title, source.closed_at, source.created_at, timestamp, timestamp, id);
      db.prepare(`DELETE FROM public_archive_list_logs WHERE archive_session_id = ?`).run(id);
    } else {
      db.prepare(`INSERT INTO public_archive_list_sessions (id, list_id, source_user_id, source_kind, source_session_id, title, status, closed_at, source_created_at, snapshot_at, display_order, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, listId, input.sourceUserId, input.sourceKind, input.sourceSessionId, source.title, source.closed_at, source.created_at, timestamp, displayOrder, actor.userId, timestamp, timestamp);
    }
    const insert = db.prepare(`INSERT INTO public_archive_list_logs (archive_session_id, source_sync_id, ordinal, time, controller, callsign, rst_sent, rst_rcvd, qth, device, power, antenna, height, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    source.logs.filter((log) => !log.deleted_at).sort((left, right) => left.time.localeCompare(right.time) || left.sync_id.localeCompare(right.sync_id)).forEach((log, index) => insert.run(id, log.sync_id, index + 1, log.time, log.controller, log.callsign, log.rst_sent, log.rst_rcvd, log.qth, log.device, log.power, log.antenna, log.height, log.remarks));
  });
  write();
  return archiveSession(db.prepare(`SELECT * FROM public_archive_list_sessions WHERE id = ?`).get(id) as Record<string, unknown>);
}

export function createArchiveSnapshot(db: Database.Database, listId: string, actor: ArchiveActor, input: ArchiveSnapshotInput): ArchiveSession { return snapshot(db, listId, actor, input); }

export function refreshArchiveSnapshot(db: Database.Database, listId: string, archiveSessionId: string, actor: ArchiveActor): ArchiveSession {
  const existing = db.prepare(`SELECT source_user_id, source_kind, source_session_id FROM public_archive_list_sessions WHERE id = ? AND list_id = ?`).get(archiveSessionId, listId) as { source_user_id: string; source_kind: 'personal' | 'collaboration'; source_session_id: string } | undefined;
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Archive session was not found');
  return snapshot(db, listId, actor, { sourceUserId: existing.source_user_id, sourceKind: existing.source_kind, sourceSessionId: existing.source_session_id }, archiveSessionId);
}

export function reorderArchiveSessions(db: Database.Database, listId: string, actor: ArchiveActor, archiveSessionIds: string[]): void {
  requireArchiveListManager(db, listId, actor);
  const existing = db.prepare(`SELECT id FROM public_archive_list_sessions WHERE list_id = ?`).all(listId) as Array<{ id: string }>;
  if (new Set(archiveSessionIds).size !== archiveSessionIds.length || existing.length !== archiveSessionIds.length || existing.some((row) => !archiveSessionIds.includes(row.id))) throw new AppError(422, 'VALIDATION_FAILED', 'Archive session order is invalid');
  db.transaction(() => archiveSessionIds.forEach((id, index) => db.prepare(`UPDATE public_archive_list_sessions SET display_order = ?, updated_at = ? WHERE id = ?`).run(index, now(), id)))();
}

export function removeArchiveSession(db: Database.Database, listId: string, archiveSessionId: string, actor: ArchiveActor): void {
  requireArchiveListManager(db, listId, actor);
  db.transaction(() => {
    const exists = db.prepare(`SELECT 1 FROM public_archive_list_sessions WHERE id = ? AND list_id = ?`).get(archiveSessionId, listId);
    if (!exists) throw new AppError(404, 'NOT_FOUND', 'Archive session was not found');
    db.prepare(`DELETE FROM public_archive_list_logs WHERE archive_session_id = ?`).run(archiveSessionId);
    db.prepare(`DELETE FROM public_archive_list_sessions WHERE id = ?`).run(archiveSessionId);
    const rows = db.prepare(`SELECT id FROM public_archive_list_sessions WHERE list_id = ? ORDER BY display_order, closed_at DESC`).all(listId) as Array<{ id: string }>;
    rows.forEach((row, index) => db.prepare(`UPDATE public_archive_list_sessions SET display_order = ? WHERE id = ?`).run(index, row.id));
  })();
}

function updatePublication(db: Database.Database, listId: string, actor: ArchiveActor, published: boolean): void { requireArchiveListManager(db, listId, actor); const timestamp = now(); db.prepare(`UPDATE public_archive_lists SET is_published = ?, unpublished_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(published ? 1 : 0, published ? null : timestamp, timestamp, listId); }
export function publishArchiveList(db: Database.Database, listId: string, actor: ArchiveActor): void { updatePublication(db, listId, actor, true); }
export function unpublishArchiveList(db: Database.Database, listId: string, actor: ArchiveActor): void { updatePublication(db, listId, actor, false); }
export function softDeleteArchiveList(db: Database.Database, listId: string, actor: ArchiveActor): void { requireArchiveListManager(db, listId, actor); const timestamp = now(); db.prepare(`UPDATE public_archive_lists SET is_published = 0, unpublished_at = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(timestamp, timestamp, timestamp, listId); }
