import { createHash } from 'crypto';
import { AppError } from '../errors/app-error';
import { rejectUnknownKeys, requireJsonObject } from '../utils/validation';

export const PERSONAL_DICTIONARY_SNAPSHOT_FORMAT_VERSION = 1;
export const PERSONAL_DICTIONARY_SNAPSHOT_REPLACE_CONFIRMATION =
  'REPLACE_PERSONAL_DICTIONARY_SNAPSHOT';
export const MAX_PERSONAL_DICTIONARY_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_PERSONAL_DICTIONARY_SNAPSHOT_ITEMS = 20_000;

export type PersonalDictionaryType = 'device' | 'antenna' | 'callsign' | 'qth';
export type PersonalDictionaryOrigin = 'user' | 'builtin';
export type PersonalDictionaryItemState = 'active' | 'deleted';

export interface PersonalDictionarySnapshotItem {
  dictType: PersonalDictionaryType;
  raw: string;
  origin: PersonalDictionaryOrigin;
  state: PersonalDictionaryItemState;
  pinyin: string | null;
  abbreviation: string | null;
}

export interface PersonalDictionarySnapshot {
  version: 1;
  exportedAt: string;
  items: PersonalDictionarySnapshotItem[];
}

export interface ValidatedPersonalDictionarySnapshot {
  snapshot: PersonalDictionarySnapshot;
  serialized: string;
  byteSize: number;
  itemCount: number;
  activeCount: number;
  deletedCount: number;
  checksum: string;
}

const SNAPSHOT_KEYS = ['version', 'exportedAt', 'items'] as const;
const ITEM_KEYS = [
  'dictType',
  'raw',
  'origin',
  'state',
  'pinyin',
  'abbreviation',
] as const;
const DICTIONARY_TYPES = new Set<PersonalDictionaryType>([
  'device',
  'antenna',
  'callsign',
  'qth',
]);
const DICTIONARY_ORIGINS = new Set<PersonalDictionaryOrigin>(['user', 'builtin']);
const ITEM_STATES = new Set<PersonalDictionaryItemState>(['active', 'deleted']);

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
  if (typeof raw !== 'string') validationError(`${path} must be a string`, path);
  if (raw.length < minimum || raw.length > maximum) {
    validationError(`${path} length is outside the allowed range`, path, {
      minimum,
      maximum,
    });
  }
  return raw;
}

function nullableString(
  value: Record<string, unknown>,
  field: string,
  path: string,
  maximum: number,
): string | null {
  const raw = value[field];
  if (raw === null) return null;
  if (typeof raw !== 'string') validationError(`${path} must be a string or null`, path);
  if (raw.length > maximum) {
    validationError(`${path} length is outside the allowed range`, path, {
      minimum: 0,
      maximum,
    });
  }
  return raw;
}

function calendarMonthLength(year: number, month: number): number {
  if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31;
  if ([4, 6, 9, 11].includes(month)) return 30;
  if (month !== 2) return 0;
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
}

function timestamp(value: Record<string, unknown>, field: string, path: string): string {
  const raw = exactString(value, field, path, 64, 1);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(raw);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9]);
  if (
    !match ||
    day < 1 ||
    day > calendarMonthLength(year, month) ||
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

function parseItem(value: unknown, index: number): PersonalDictionarySnapshotItem {
  const path = `items[${index}]`;
  const row = requireJsonObject(value);
  rejectUnknownKeys(row, ITEM_KEYS);
  const dictType = exactString(row, 'dictType', `${path}.dictType`, 16, 1);
  const origin = exactString(row, 'origin', `${path}.origin`, 16, 1);
  const state = exactString(row, 'state', `${path}.state`, 16, 1);
  if (!DICTIONARY_TYPES.has(dictType as PersonalDictionaryType)) {
    validationError(`${path}.dictType is unsupported`, `${path}.dictType`);
  }
  if (!DICTIONARY_ORIGINS.has(origin as PersonalDictionaryOrigin)) {
    validationError(`${path}.origin is unsupported`, `${path}.origin`);
  }
  if (!ITEM_STATES.has(state as PersonalDictionaryItemState)) {
    validationError(`${path}.state is unsupported`, `${path}.state`);
  }
  if (state === 'active' && origin !== 'user') {
    validationError(
      `${path}.origin must be user for an active synchronized item`,
      `${path}.origin`,
    );
  }
  const pinyin = nullableString(row, 'pinyin', `${path}.pinyin`, 1_000);
  const abbreviation = nullableString(
    row,
    'abbreviation',
    `${path}.abbreviation`,
    500,
  );
  if (state === 'deleted' && (pinyin !== null || abbreviation !== null)) {
    validationError(
      `${path} deleted items must not carry searchable values`,
      path,
    );
  }
  const raw = exactString(row, 'raw', `${path}.raw`, 500, 1);
  if (raw.trim() !== raw || raw.trim().length === 0) {
    validationError(`${path}.raw must be trimmed and non-empty`, `${path}.raw`);
  }
  return {
    dictType: dictType as PersonalDictionaryType,
    raw,
    origin: origin as PersonalDictionaryOrigin,
    state: state as PersonalDictionaryItemState,
    pinyin,
    abbreviation,
  };
}

function canonicalChecksum(snapshot: PersonalDictionarySnapshot): string {
  const compareUtf8 = (left: string, right: string) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  const items = [...snapshot.items].sort((left, right) =>
    compareUtf8(left.dictType, right.dictType) || compareUtf8(left.raw, right.raw));
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => compareUtf8(left, right))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ version: snapshot.version, items })))
    .digest('hex');
}

export function validatePersonalDictionarySnapshot(
  value: unknown,
): ValidatedPersonalDictionarySnapshot {
  const root = requireJsonObject(value);
  rejectUnknownKeys(root, SNAPSHOT_KEYS);
  if (root.version !== PERSONAL_DICTIONARY_SNAPSHOT_FORMAT_VERSION) {
    validationError('snapshot.version must be 1', 'snapshot.version', {
      supportedVersion: PERSONAL_DICTIONARY_SNAPSHOT_FORMAT_VERSION,
    });
  }
  if (!Array.isArray(root.items)) validationError('items must be an array', 'items');
  if (root.items.length > MAX_PERSONAL_DICTIONARY_SNAPSHOT_ITEMS) {
    throw new AppError(
      413,
      'PERSONAL_DICTIONARY_SNAPSHOT_TOO_LARGE',
      'The personal dictionary snapshot exceeds the item limit',
      { maximum: MAX_PERSONAL_DICTIONARY_SNAPSHOT_ITEMS, actual: root.items.length },
    );
  }
  const items = root.items.map(parseItem);
  const identities = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const identity = `${items[index].dictType}\0${items[index].raw}`;
    if (identities.has(identity)) {
      validationError(
        'Dictionary item identities must be unique',
        `items[${index}].raw`,
        { dictType: items[index].dictType, raw: items[index].raw },
      );
    }
    identities.add(identity);
  }
  const snapshot: PersonalDictionarySnapshot = {
    version: PERSONAL_DICTIONARY_SNAPSHOT_FORMAT_VERSION,
    exportedAt: timestamp(root, 'exportedAt', 'snapshot.exportedAt'),
    items,
  };
  const serialized = JSON.stringify(snapshot);
  const byteSize = Buffer.byteLength(serialized, 'utf8');
  if (byteSize > MAX_PERSONAL_DICTIONARY_SNAPSHOT_BYTES) {
    throw new AppError(
      413,
      'PERSONAL_DICTIONARY_SNAPSHOT_TOO_LARGE',
      'The personal dictionary snapshot exceeds the byte limit',
      { maximum: MAX_PERSONAL_DICTIONARY_SNAPSHOT_BYTES, actual: byteSize },
    );
  }
  const activeCount = items.filter((item) => item.state === 'active').length;
  return {
    snapshot,
    serialized,
    byteSize,
    itemCount: items.length,
    activeCount,
    deletedCount: items.length - activeCount,
    checksum: canonicalChecksum(snapshot),
  };
}
