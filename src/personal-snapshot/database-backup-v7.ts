import { AppError } from '../errors/app-error';
import {
  PersonalSnapshot,
  validatePersonalSnapshot,
} from './model';

export const CLIENT_DATABASE_BACKUP_FORMAT_VERSION = 7;

export interface StoredPersonalSnapshotExportRow {
  revision: number;
  format_version: number;
  snapshot_json: string;
  session_count: number;
  log_count: number;
  byte_size: number;
  checksum: string;
}

export interface ClientDatabaseBackupV7 {
  version: 7;
  exportedAt: string;
  logs: PersonalSnapshot['logs'];
  sessions: PersonalSnapshot['sessions'];
  dictionary_items: [];
  settings: [];
  oplog: [];
  collaboration_bindings: [];
  entity_shadows: [];
  sync_outbox: [];
  applied_events: [];
  sync_conflicts: [];
  collaboration_live_drafts: [];
  collaboration_offline_records: [];
}

function corruptSnapshot(code: string, message: string, cause?: unknown): AppError {
  return new AppError(
    500,
    code,
    message,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

export function validatedStoredPersonalSnapshotForExport(
  row: StoredPersonalSnapshotExportRow,
): PersonalSnapshot {
  try {
    const validated = validatePersonalSnapshot(JSON.parse(row.snapshot_json) as unknown);
    if (
      validated.snapshot.version !== Number(row.format_version) ||
      validated.sessionCount !== Number(row.session_count) ||
      validated.logCount !== Number(row.log_count) ||
      validated.byteSize !== Number(row.byte_size) ||
      validated.checksum !== row.checksum
    ) {
      throw corruptSnapshot(
        'PERSONAL_SNAPSHOT_CORRUPT',
        'The stored personal cloud snapshot failed integrity validation',
      );
    }
    return validated.snapshot;
  } catch (error) {
    if (error instanceof AppError && error.code === 'PERSONAL_SNAPSHOT_CORRUPT') {
      throw error;
    }
    throw corruptSnapshot(
      'PERSONAL_SNAPSHOT_CORRUPT',
      'The stored personal cloud snapshot failed integrity validation',
      error,
    );
  }
}

export function createClientSessionDatabaseBackupV7(
  records: PersonalSnapshot,
  sessionId: string,
  exportedAt = new Date().toISOString(),
): ClientDatabaseBackupV7 {
  const session = records.sessions.find((item) => item.session_id === sessionId);
  if (!session) {
    throw new AppError(
      404,
      'PERSONAL_SNAPSHOT_SESSION_NOT_FOUND',
      'The requested Session is not present in the personal cloud snapshot',
      { sessionId },
    );
  }

  return {
    version: CLIENT_DATABASE_BACKUP_FORMAT_VERSION,
    exportedAt,
    logs: records.logs.filter((log) => log.session_id === sessionId),
    sessions: [session],
    dictionary_items: [],
    settings: [],
    oplog: [],
    collaboration_bindings: [],
    entity_shadows: [],
    sync_outbox: [],
    applied_events: [],
    sync_conflicts: [],
    collaboration_live_drafts: [],
    collaboration_offline_records: [],
  };
}

export function clientSessionDatabaseBackupV7Filename(
  sessionId: string,
  recordRevision: number,
): string {
  const fileSafeSessionId = sessionId.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `openlogtool-session-${fileSafeSessionId}-r${recordRevision}-v7.json`;
}
