import { createHash } from 'crypto';
import { AppError } from '../errors/app-error';
import {
  PersonalDictionarySnapshot,
  validatePersonalDictionarySnapshot,
} from '../personal-dictionary-snapshot/model';
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

export interface StoredPersonalDictionarySnapshotExportRow {
  revision: number;
  format_version: number;
  snapshot_json: string;
  item_count: number;
  active_count: number;
  deleted_count: number;
  byte_size: number;
  checksum: string;
}

export interface ClientDatabaseBackupV7 {
  version: 7;
  exportedAt: string;
  logs: PersonalSnapshot['logs'];
  sessions: PersonalSnapshot['sessions'];
  dictionary_items: Array<{
    dict_type: string;
    raw: string;
    pinyin: string | null;
    abbreviation: string | null;
    sync_id: string;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
    origin: 'user' | 'builtin';
  }>;
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

export function validatedStoredPersonalDictionarySnapshotForExport(
  row: StoredPersonalDictionarySnapshotExportRow,
): PersonalDictionarySnapshot {
  try {
    const validated = validatePersonalDictionarySnapshot(
      JSON.parse(row.snapshot_json) as unknown,
    );
    if (
      validated.snapshot.version !== Number(row.format_version) ||
      validated.itemCount !== Number(row.item_count) ||
      validated.activeCount !== Number(row.active_count) ||
      validated.deletedCount !== Number(row.deleted_count) ||
      validated.byteSize !== Number(row.byte_size) ||
      validated.checksum !== row.checksum
    ) {
      throw corruptSnapshot(
        'PERSONAL_DICTIONARY_SNAPSHOT_CORRUPT',
        'The stored personal dictionary snapshot failed integrity validation',
      );
    }
    return validated.snapshot;
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === 'PERSONAL_DICTIONARY_SNAPSHOT_CORRUPT'
    ) {
      throw error;
    }
    throw corruptSnapshot(
      'PERSONAL_DICTIONARY_SNAPSHOT_CORRUPT',
      'The stored personal dictionary snapshot failed integrity validation',
      error,
    );
  }
}

function clientDictionaryType(value: string): string {
  return `${value}_dictionary`;
}

function dictionarySyncId(dictType: string, raw: string): string {
  const digest = createHash('sha256')
    .update(`openlogtool/personal-cloud-dictionary/v1\0${dictType}\0${raw}`)
    .digest('hex');
  return `dict-cloud-${digest.slice(0, 32)}`;
}

export function createClientDatabaseBackupV7(
  records: PersonalSnapshot,
  dictionary: PersonalDictionarySnapshot | undefined,
  exportedAt = new Date().toISOString(),
): ClientDatabaseBackupV7 {
  const dictionaryItems = (dictionary?.items ?? []).map((item) => {
    const dictType = clientDictionaryType(item.dictType);
    const timestamp = dictionary?.exportedAt ?? exportedAt;
    return {
      dict_type: dictType,
      raw: item.raw,
      pinyin: item.pinyin,
      abbreviation: item.abbreviation,
      sync_id: dictionarySyncId(dictType, item.raw),
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: item.state === 'deleted' ? timestamp : null,
      origin: item.origin,
    };
  });

  return {
    version: CLIENT_DATABASE_BACKUP_FORMAT_VERSION,
    exportedAt,
    logs: records.logs,
    sessions: records.sessions,
    dictionary_items: dictionaryItems,
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

export function clientDatabaseBackupV7Filename(
  recordRevision: number,
  dictionaryRevision: number,
): string {
  return `openlogtool-personal-r${recordRevision}-d${dictionaryRevision}-v7.json`;
}
