import Database from 'better-sqlite3';
import { findMembership } from '../collaboration/access';
import { AppError } from '../errors/app-error';

export interface ArchiveActor {
  userId: string;
  role: 'admin' | 'user';
}

interface ArchiveListRow {
  owner_user_id: string;
  deleted_at: string | null;
}

function listRow(db: Database.Database, listId: string): ArchiveListRow {
  const list = db.prepare(`SELECT owner_user_id, deleted_at FROM public_archive_lists WHERE id = ?`)
    .get(listId) as ArchiveListRow | undefined;
  if (!list || list.deleted_at) {
    throw new AppError(404, 'NOT_FOUND', 'Archive list was not found');
  }
  return list;
}

export function isArchiveAdministrator(actor: ArchiveActor): boolean {
  return actor.role === 'admin';
}

export function requireArchiveListManager(
  db: Database.Database,
  listId: string,
  actor: ArchiveActor,
): void {
  const list = listRow(db, listId);
  const member = db.prepare(`SELECT 1 FROM public_archive_list_members WHERE list_id = ? AND user_id = ?`)
    .get(listId, actor.userId);
  if (!isArchiveAdministrator(actor) && list.owner_user_id !== actor.userId && !member) {
    throw new AppError(403, 'ARCHIVE_LIST_FORBIDDEN', 'Archive list management is forbidden');
  }
}

export function requireArchiveListOwnerOrAdmin(
  db: Database.Database,
  listId: string,
  actor: ArchiveActor,
): void {
  const list = listRow(db, listId);
  if (!isArchiveAdministrator(actor) && list.owner_user_id !== actor.userId) {
    throw new AppError(403, 'ARCHIVE_LIST_FORBIDDEN', 'Archive list owner access is required');
  }
}

export function effectiveSourceAccounts(db: Database.Database, listId: string): Set<string> {
  const list = listRow(db, listId);
  const accounts = new Set([list.owner_user_id]);
  const rows = db.prepare(`SELECT user_id FROM public_archive_list_sources WHERE list_id = ?`).all(listId) as Array<{ user_id: string }>;
  for (const row of rows) accounts.add(row.user_id);
  return accounts;
}

export function requireArchiveSourceAccount(
  db: Database.Database,
  listId: string,
  sourceUserId: string,
): void {
  if (!effectiveSourceAccounts(db, listId).has(sourceUserId)) {
    throw new AppError(403, 'ARCHIVE_SOURCE_NOT_AUTHORIZED', 'Archive source account is not authorized');
  }
}

export function requireArchiveSourceSessionVisible(
  db: Database.Database,
  actor: ArchiveActor,
  sourceUserId: string,
  sourceKind: 'personal' | 'collaboration',
  sourceSessionId: string,
): void {
  if (sourceKind === 'personal') {
    if (actor.userId !== sourceUserId) {
      throw new AppError(403, 'ARCHIVE_LIST_FORBIDDEN', 'Personal source session is not visible');
    }
    return;
  }
  if (!findMembership(db, sourceSessionId, actor.userId)) {
    throw new AppError(403, 'ARCHIVE_LIST_FORBIDDEN', 'Collaboration source session is not visible');
  }
}
