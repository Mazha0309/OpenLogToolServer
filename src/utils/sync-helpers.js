/**
 * Sync Protocol v1 conflict resolution utilities
 * Implements the rules from OpenLogTool_SYNC_PROTOCOL_v1.md §8 and §12.1
 */

/**
 * Normalize a date value to a Date object, returning null for falsy inputs.
 * @param {string|Date|null} value
 * @returns {Date|null}
 */
export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Get the latest non-null date from the given values.
 * @param {...(string|Date|null)} values
 * @returns {Date|null}
 */
export function latestTimestamp(...values) {
  const dates = values.map(toDate).filter(d => d !== null);
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map(d => d.getTime())));
}

/**
 * Apply an incoming record against the existing server record using v1 protocol rules.
 *
 * Rules (from §8):
 * - No existing record -> INSERT incoming
 * - Delete vs Modify -> DELETE wins (always)
 * - Delete vs Delete -> keep the one with later updated_at
 * - Modify vs Modify -> LWW (later updated_at wins)
 * - Same timestamp but different content -> fallback: deleted wins, else server wins
 * - Duplicate receipt -> idempotent, no side effects
 *
 * @param {Object|null} existing - The existing server record (null if not found)
 * @param {Object} incoming - The incoming client record
 * @returns {{ action: string, record: Object, conflict: boolean }}
 *   action: 'insert' | 'update' | 'soft_delete' | 'update_deleted_record' | 'ignore' | 'ignore_keep_server'
 *   record: the winning record (incoming or existing)
 *   conflict: true if there was a real conflict (both had modifications)
 */
export function applyIncomingRecord(existing, incoming) {
  if (!existing) {
    return { action: 'insert', record: incoming, conflict: false };
  }

  const existingDeleted = !!toDate(existing.deleted_at ?? existing.deletedAt);
  const incomingDeleted = !!toDate(incoming.deleted_at ?? incoming.deletedAt);

  if (incomingDeleted && !existingDeleted) {
    return { action: 'soft_delete', record: incoming, conflict: true };
  }

  if (incomingDeleted && existingDeleted) {
    const incomingUpdated = toDate(incoming.updated_at ?? incoming.updatedAt);
    const existingUpdated = toDate(existing.updated_at ?? existing.updatedAt);

    if (incomingUpdated && existingUpdated && incomingUpdated.getTime() >= existingUpdated.getTime()) {
      return { action: 'update_deleted_record', record: incoming, conflict: false };
    }
    return { action: 'ignore', record: existing, conflict: false };
  }

  if (!incomingDeleted && existingDeleted) {
    return { action: 'ignore', record: existing, conflict: true };
  }

  const incomingUpdated = toDate(incoming.updated_at ?? incoming.updatedAt);
  const existingUpdated = toDate(existing.updated_at ?? existing.updatedAt);

  if (incomingUpdated && existingUpdated && incomingUpdated.getTime() > existingUpdated.getTime()) {
    return { action: 'update', record: incoming, conflict: true };
  }

  if (incomingUpdated && existingUpdated && incomingUpdated.getTime() === existingUpdated.getTime()) {
    return { action: 'ignore_keep_server', record: existing, conflict: true };
  }

  return { action: 'ignore', record: existing, conflict: false };
}

/**
 * Convert a record's field names from camelCase to snake_case for API responses.
 * @param {Object} record - Record with camelCase fields
 * @returns {Object} Record with snake_case fields for sync protocol responses
 */
export function toSyncProtocolFields(record) {
  if (!record) return null;
  const out = { ...record };
  if ('syncId' in out || 'id' in out) {
    out.sync_id = out.syncId ?? out.id;
    delete out.syncId;
  }
  if ('createdAt' in out) { out.created_at = out.createdAt; delete out.createdAt; }
  if ('updatedAt' in out) { out.updated_at = out.updatedAt; delete out.updatedAt; }
  if ('deletedAt' in out) { out.deleted_at = out.deletedAt; delete out.deletedAt; }
  if ('sourceDeviceId' in out) { out.source_device_id = out.sourceDeviceId; delete out.sourceDeviceId; }
  if ('clientUpdatedAt' in out) { out.client_updated_at = out.clientUpdatedAt; delete out.clientUpdatedAt; }
  if ('serverUpdatedAt' in out) { out.server_updated_at = out.serverUpdatedAt; delete out.serverUpdatedAt; }
  if ('userId' in out) { out.user_id = out.userId; delete out.userId; }
  if ('localId' in out) { out.local_id = out.localId; delete out.localId; }
  if ('deviceId' in out) { out.device_id = out.deviceId; delete out.deviceId; }
  if ('logsData' in out) { out.logs_data = out.logsData; delete out.logsData; }
  if ('logCount' in out) { out.log_count = out.logCount; delete out.logCount; }
  if ('recordedAt' in out) { out.recorded_at = out.recordedAt; delete out.recordedAt; }
  if ('sessionId' in out) { out.session_id = out.sessionId; delete out.sessionId; }
  if ('closedAt' in out) { out.closed_at = out.closedAt; delete out.closedAt; }
  return out;
}

/**
 * Convert a record's field names from snake_case (API) to camelCase (internal).
 * @param {Object} record - Record with snake_case fields
 * @returns {Object} Record with camelCase fields
 */
export function fromSyncProtocolFields(record) {
  if (!record) return null;
  const out = { ...record };
  if ('sync_id' in out) { out.syncId = out.sync_id; out.id = out.sync_id; delete out.sync_id; }
  if ('created_at' in out) { out.createdAt = out.created_at; delete out.created_at; }
  if ('updated_at' in out) { out.updatedAt = out.updated_at; delete out.updated_at; }
  if ('deleted_at' in out) { out.deletedAt = out.deleted_at; delete out.deleted_at; }
  if ('source_device_id' in out) { out.sourceDeviceId = out.source_device_id; delete out.source_device_id; }
  if ('client_updated_at' in out) { out.clientUpdatedAt = out.client_updated_at; delete out.client_updated_at; }
  if ('server_updated_at' in out) { out.serverUpdatedAt = out.server_updated_at; delete out.server_updated_at; }
  if ('session_id' in out) { out.sessionId = out.session_id; delete out.session_id; }
  if ('closed_at' in out) { out.closedAt = out.closed_at; delete out.closed_at; }
  return out;
}

/**
 * Dictionary type mapping: internal DB type enum -> v1 protocol category name
 * The v1 protocol uses nested dictionaries: { bands, modes, rigs, antennas }
 * The DB uses type enum: 'device', 'antenna', 'qth', 'callsign'
 * Extended to support 'band', 'mode' as used in the protocol.
 */
export const DICT_TYPE_TO_PROTOCOL = {
  'band': 'bands',
  'device': 'rigs',
  'antenna': 'antennas',
  'mode': 'modes',
  'qth': 'qths',
  'callsign': 'callsigns',
};

export const PROTOCOL_TO_DICT_TYPE = {};
for (const [dbType, protoKey] of Object.entries(DICT_TYPE_TO_PROTOCOL)) {
  PROTOCOL_TO_DICT_TYPE[protoKey] = dbType;
}

/**
 * Convert a flat dictionary array into the nested format expected by v1 protocol.
 * Input: [{ type: 'band', raw: 'UHF', ... }, { type: 'mode', raw: 'FM', ... }]
 * Output: { bands: [{ ... }], modes: [{ ... }], rigs: [], antennas: [] }
 * @param {Array} flatDicts - Flat dictionary array from DB
 * @returns {Object} Nested dictionary object for v1 protocol response
 */
export function nestDictionaries(flatDicts) {
  const result = { bands: [], modes: [], rigs: [], antennas: [] };
  for (const dict of flatDicts) {
    const protoKey = DICT_TYPE_TO_PROTOCOL[dict.type];
    if (protoKey && protoKey in result) {
      result[protoKey].push(toSyncProtocolFields(dict));
    } else if (protoKey) {
      result[protoKey] = result[protoKey] || [];
      result[protoKey].push(toSyncProtocolFields(dict));
    }
  }
  return result;
}

/**
 * Flatten a nested dictionary payload from v1 protocol into a flat array.
 * Input: { bands: [{ ... }], modes: [{ ... }], rigs: [], antennas: [] }
 * Output: [{ type: 'band', ... }, { type: 'mode', ... }]
 * @param {Object} nestedDicts - Nested dictionary object from v1 protocol request
 * @returns {Array} Flat dictionary array for DB operations
 */
export function flattenDictionaries(nestedDicts) {
  if (!nestedDicts || typeof nestedDicts !== 'object') return [];
  const result = [];
  for (const [protoKey, items] of Object.entries(nestedDicts)) {
    if (!Array.isArray(items)) continue;
    const dbType = PROTOCOL_TO_DICT_TYPE[protoKey] || protoKey.replace(/s$/, '');
    for (const item of items) {
      const converted = fromSyncProtocolFields(item);
      converted.type = dbType;
      result.push(converted);
    }
  }
  return result;
}
