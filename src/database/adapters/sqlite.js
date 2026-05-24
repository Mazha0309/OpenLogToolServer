/**
 * SQLite adapter for OpenLogToolServer.
 *
 * Schema mirrors the Flutter client (database_helper.dart) with the
 * addition of a user_id column on every record so data is scoped to
 * the sub-account that owns it.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

function isoNow() {
  return new Date().toISOString();
}

function generateSyncId(prefix) {
  const suffix = Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 65536).toString(16).padStart(4, '0')
  ).join('');
  return `${prefix}-${Date.now() * 1000}-${suffix}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id TEXT UNIQUE NOT NULL,
  time TEXT NOT NULL,
  controller TEXT NOT NULL,
  callsign TEXT NOT NULL,
  report TEXT DEFAULT '',
  qth TEXT DEFAULT '',
  device TEXT DEFAULT '',
  power TEXT DEFAULT '',
  antenna TEXT DEFAULT '',
  height TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_device_id TEXT,
  user_id TEXT NOT NULL,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id);
CREATE INDEX IF NOT EXISTS idx_logs_updated ON logs(updated_at);

CREATE TABLE IF NOT EXISTS device_dictionary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id TEXT UNIQUE NOT NULL,
  raw TEXT NOT NULL UNIQUE,
  pinyin TEXT DEFAULT '',
  abbreviation TEXT DEFAULT '',
  type TEXT DEFAULT 'device',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_device_id TEXT,
  user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devdict_user ON device_dictionary(user_id);

CREATE TABLE IF NOT EXISTS antenna_dictionary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id TEXT UNIQUE NOT NULL,
  raw TEXT NOT NULL UNIQUE,
  pinyin TEXT DEFAULT '',
  abbreviation TEXT DEFAULT '',
  type TEXT DEFAULT 'antenna',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_device_id TEXT,
  user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_antdict_user ON antenna_dictionary(user_id);

CREATE TABLE IF NOT EXISTS qth_dictionary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id TEXT UNIQUE NOT NULL,
  raw TEXT NOT NULL UNIQUE,
  pinyin TEXT DEFAULT '',
  abbreviation TEXT DEFAULT '',
  type TEXT DEFAULT 'qth',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_device_id TEXT,
  user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qthdict_user ON qth_dictionary(user_id);

CREATE TABLE IF NOT EXISTS callsign_dictionary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id TEXT UNIQUE NOT NULL,
  raw TEXT NOT NULL UNIQUE,
  pinyin TEXT DEFAULT '',
  abbreviation TEXT DEFAULT '',
  type TEXT DEFAULT 'callsign',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_device_id TEXT,
  user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calldict_user ON callsign_dictionary(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  deleted_at TEXT,
  source_device_id TEXT,
  user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  logs_data TEXT NOT NULL DEFAULT '[]',
  log_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_device_id TEXT,
  user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id);

CREATE TABLE IF NOT EXISTS callsign_qth_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id TEXT UNIQUE NOT NULL,
  callsign TEXT NOT NULL,
  qth TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_device_id TEXT,
  user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cqth_callsign ON callsign_qth_history(callsign);
CREATE INDEX IF NOT EXISTS idx_cqth_user ON callsign_qth_history(user_id);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  shareCode TEXT UNIQUE NOT NULL,
  fromUserId TEXT NOT NULL,
  toUserId TEXT,
  sessionId TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'readwrite',
  status TEXT NOT NULL DEFAULT 'pending',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  name TEXT,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  passwordHash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  parentId TEXT,
  theme TEXT DEFAULT 'light',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  sync_type TEXT NOT NULL,
  records_count INTEGER NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_links (
  id TEXT PRIMARY KEY,
  url TEXT DEFAULT '',
  share_code TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
`;

const DICT_TABLES = {
  device: 'device_dictionary',
  antenna: 'antenna_dictionary',
  qth: 'qth_dictionary',
  callsign: 'callsign_dictionary',
};

export class SqliteAdapter {
  constructor(opts = {}) {
    this.dbPath = opts.path || path.join(process.cwd(), 'data', 'openlogtool.db');
    this.db = null;
  }

  async connect() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);

    // Migration: add user_id to public_links if missing (added after initial schema)
    try {
      this.db.exec('ALTER TABLE public_links ADD COLUMN user_id TEXT');
    } catch (_) { /* column already exists */ }

    // Seed default admin user if the table is empty (mirrors memory adapter)
    const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    if (!existing) {
      const { default: bcrypt } = await import('bcryptjs');
      const hash = bcrypt.hashSync('admin123', 10);
      this.db.prepare('INSERT INTO users (id, username, passwordHash, role, theme, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
        randomUUID(), 'admin', hash, 'admin', 'light', new Date().toISOString());
    }
  }

  async disconnect() {
    if (this.db) { this.db.close(); this.db = null; }
  }

  // ── helpers ──────────────────────────────────────────────────

  _dictTable(type) { return DICT_TABLES[type] || null; }

  _rowToObj(row) {
    if (!row) return null;
    return { ...row };
  }

  // ── LOGS ─────────────────────────────────────────────────────

  async findLogs(query = {}, pagination = { page: 1, pageSize: 20 }) {
    const { page, pageSize } = pagination;
    const offset = (page - 1) * pageSize;
    const where = [];
    const params = {};
    if (query.userId) { where.push('user_id = @userId'); params.userId = query.userId; }
    if (query.deletedAt == null) where.push('deleted_at IS NULL');
    const sql = `SELECT * FROM logs${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT @limit OFFSET @offset`;
    const rows = this.db.prepare(sql).all({ ...params, limit: pageSize, offset });
    const total = this.db.prepare(`SELECT COUNT(*) as c FROM logs${where.length ? ' WHERE ' + where.join(' AND ') : ''}`).get(params);
    return { data: rows, total: total?.c ?? 0, page, pageSize };
  }

  async findLogById(id) { return this._rowToObj(this.db.prepare('SELECT * FROM logs WHERE id = ?').get(id)) || null; }

  async createLog(data) {
    const syncId = data.sync_id || data.syncId || generateSyncId('log');
    const now = isoNow();
    const stmt = this.db.prepare(`INSERT INTO logs (sync_id, time, controller, callsign, report, qth, device, power, antenna, height, created_at, updated_at, deleted_at, source_device_id, user_id, session_id) VALUES (@sync_id, @time, @controller, @callsign, @report, @qth, @device, @power, @antenna, @height, @created_at, @updated_at, NULL, @source_device_id, @user_id, @session_id)`);
    const info = stmt.run({
      sync_id: syncId,
      time: data.time || '',
      controller: data.controller || '',
      callsign: data.callsign || '',
      report: data.report ?? '',
      qth: data.qth ?? '',
      device: data.device ?? '',
      power: data.power ?? '',
      antenna: data.antenna ?? '',
      height: data.height ?? '',
      created_at: data.createdAt || data.created_at || now,
      updated_at: data.updatedAt || data.updated_at || now,
      source_device_id: data.sourceDeviceId || data.source_device_id || null,
      user_id: data.userId || data.user_id,
      session_id: data.sessionId || data.session_id || null,
    });
    return { ...data, sync_id: syncId, id: info.lastInsertRowid };
  }

  async updateLog(id, data) {
    const now = isoNow();
    const sets = ['updated_at = ?'];
    const vals = [now];
    const fields = ['time','controller','callsign','report','qth','device','power','antenna','height','deleted_at','session_id'];
    for (const f of fields) {
      const v = data[f] ?? data[f.replace(/_([a-z])/g, (_,c) => c.toUpperCase())];
      if (v !== undefined) { sets.push(`${f} = ?`); vals.push(v); }
    }
    vals.push(id);
    const info = this.db.prepare(`UPDATE logs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (info.changes === 0) return null;
    return this.findLogById(id);
  }

  async deleteLog(id) {
    const stmt = this.db.prepare('UPDATE logs SET deleted_at = ? WHERE id = ?');
    stmt.run(isoNow(), id);
    return true;
  }

  async upsertLog(data, deviceId, userId) {
    return this.upsertLogSync(data, deviceId, userId);
  }

  async upsertLogSync(data, deviceId, userId) {
    const syncId = data.sync_id || data.syncId || data.id;
    const existing = syncId ? this.db.prepare('SELECT * FROM logs WHERE sync_id = ?').get(syncId) : null;
    if (existing) {
      const now = isoNow();
      const incomingUpdated = data.updated_at || data.updatedAt || now;
      const existingUpdated = existing.updated_at;
      if (incomingUpdated >= existingUpdated) {
        this.db.prepare(`UPDATE logs SET time=?, controller=?, callsign=?, report=?, qth=?, device=?, power=?, antenna=?, height=?, updated_at=?, deleted_at=NULL WHERE sync_id=?`).run(
          data.time || '', data.controller || '', data.callsign || '', data.report ?? '', data.qth ?? '', data.device ?? '', data.power ?? '', data.antenna ?? '', data.height ?? '', incomingUpdated, syncId);
      }
      return this.db.prepare('SELECT * FROM logs WHERE sync_id = ?').get(syncId);
    }
    return this.createLog({ ...data, userId: userId || data.userId, source_device_id: deviceId });
  }

  async findSince(deviceId, timestamp, userId) {
    return this.db.prepare('SELECT * FROM logs WHERE user_id = ? AND updated_at > ?').all(userId, timestamp);
  }

  async findLogsSince(timestamp, userId) {
    return this.db.prepare('SELECT * FROM logs WHERE user_id = ? AND (updated_at > ? OR deleted_at > ?)').all(userId, timestamp, timestamp);
  }

  async softDeleteLog(id, deletedAt, userId) {
    this.db.prepare('UPDATE logs SET deleted_at = ? WHERE sync_id = ? AND user_id = ?').run(deletedAt || isoNow(), id, userId);
  }

  async findSharedLogs(fromUserId, toUserId) {
    const shares = this.db.prepare("SELECT sessionId FROM shares WHERE fromUserId = ? AND toUserId = ? AND status = 'active'").all(fromUserId, toUserId);
    if (shares.length === 0) return [];
    const sids = shares.map(s => s.sessionId);
    const placeholders = sids.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM logs WHERE session_id IN (${placeholders}) AND deleted_at IS NULL`).all(...sids);
  }

  // ── DICTIONARIES ─────────────────────────────────────────────

  async findDictionaries(type, query) {
    const table = this._dictTable(type);
    if (!table) return [];
    const where = ['deleted_at IS NULL'];
    const params = {};
    if (query.userId) { where.push('user_id = @userId'); params.userId = query.userId; }
    return this.db.prepare(`SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY raw ASC`).all(params);
  }

  async findDictionaryById(id) {
    for (const table of Object.values(DICT_TABLES)) {
      const r = this.db.prepare(`SELECT * FROM ${table} WHERE id = ? OR sync_id = ?`).get(id, id);
      if (r) return r;
    }
    return null;
  }

  async findDictionariesByUser(userId) {
    const results = [];
    for (const [type, table] of Object.entries(DICT_TABLES)) {
      const rows = this.db.prepare(`SELECT *, ? as type FROM ${table} WHERE user_id = ? AND deleted_at IS NULL`).all(type, userId);
      results.push(...rows);
    }
    return results;
  }

  async findDictionariesSince(timestamp, userId) {
    const results = [];
    for (const [type, table] of Object.entries(DICT_TABLES)) {
      const rows = this.db.prepare(`SELECT *, ? as type FROM ${table} WHERE user_id = ? AND (updated_at > ? OR deleted_at > ?)`).all(type, userId, timestamp, timestamp);
      results.push(...rows);
    }
    return results;
  }

  async createDictionary(type, data) {
    const table = this._dictTable(type);
    if (!table) return null;
    const syncId = data.syncId || data.sync_id || generateSyncId(type);
    const now = isoNow();
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO ${table} (sync_id, raw, pinyin, abbreviation, type, created_at, updated_at, source_device_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(syncId, data.raw, data.pinyin || '', data.abbreviation || '', type, now, now, data.sourceDeviceId || data.source_device_id || null, data.userId || data.user_id);
    return this.db.prepare(`SELECT * FROM ${table} WHERE sync_id = ?`).get(syncId);
  }

  async updateDictionary(id, data) {
    for (const table of Object.values(DICT_TABLES)) {
      const r = this.db.prepare(`SELECT * FROM ${table} WHERE id = ? OR sync_id = ?`).get(id, id);
      if (r) {
        const now = isoNow();
        this.db.prepare(`UPDATE ${table} SET raw=?, pinyin=?, abbreviation=?, updated_at=? WHERE id=?`).run(data.raw || r.raw, data.pinyin ?? r.pinyin, data.abbreviation ?? r.abbreviation, now, r.id);
        return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.id);
      }
    }
    return null;
  }

  async deleteDictionary(id) {
    for (const table of Object.values(DICT_TABLES)) {
      const r = this.db.prepare(`SELECT * FROM ${table} WHERE id = ? OR sync_id = ?`).get(id, id);
      if (r) {
        this.db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(isoNow(), r.id);
        return true;
      }
    }
    return false;
  }

  async bulkCreateDictionary(type, items) {
    if (!items || items.length === 0) return [];
    const table = this._dictTable(type);
    if (!table) return [];
    const now = isoNow();
    const insert = this.db.prepare(`INSERT OR IGNORE INTO ${table} (sync_id, raw, pinyin, abbreviation, type, created_at, updated_at, source_device_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const txn = this.db.transaction(() => {
      for (const item of items) {
        const sid = item.syncId || item.sync_id || generateSyncId(type);
        insert.run(sid, item.raw, item.pinyin || '', item.abbreviation || '', type, now, now, item.sourceDeviceId || item.source_device_id || null, item.userId || item.user_id);
      }
    });
    txn();
    return this.db.prepare(`SELECT * FROM ${table} WHERE created_at = ?`).all(now);
  }

  async bulkUpsertDictionary(items, userId) {
    const results = [];
    for (const item of items) {
      results.push(await this.upsertDictionarySync(item, userId));
    }
    return results;
  }

  async upsertDictionarySync(data, userId) {
    const type = data.type;
    const table = this._dictTable(type);
    if (!table) return null;
    const syncId = data.syncId || data.sync_id || data.id;
    const existing = syncId ? this.db.prepare(`SELECT * FROM ${table} WHERE sync_id = ?`).get(syncId) : (data.raw ? this.db.prepare(`SELECT * FROM ${table} WHERE raw = ?`).get(data.raw) : null);
    if (existing) {
      const now = isoNow();
      this.db.prepare(`UPDATE ${table} SET raw=?, pinyin=?, abbreviation=?, updated_at=?, deleted_at=NULL WHERE id=?`).run(data.raw || existing.raw, data.pinyin ?? existing.pinyin, data.abbreviation ?? existing.abbreviation, now, existing.id);
      return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(existing.id);
    }
    return this.createDictionary(type, { ...data, userId: userId || data.userId });
  }

  async softDeleteDictionary(id, deletedAt, userId) {
    for (const table of Object.values(DICT_TABLES)) {
      const r = this.db.prepare(`SELECT * FROM ${table} WHERE sync_id = ?`).get(id);
      if (r) {
        this.db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE sync_id = ?`).run(deletedAt || isoNow(), id);
        return;
      }
    }
  }

  // ── SESSIONS ─────────────────────────────────────────────────

  async findSessionById(sessionId) {
    return this._rowToObj(this.db.prepare('SELECT * FROM sessions WHERE session_id = ? AND deleted_at IS NULL').get(sessionId));
  }

  async findSessionsSince(timestamp, userId) {
    return this.db.prepare('SELECT * FROM sessions WHERE user_id = ? AND (updated_at > ? OR deleted_at > ?)').all(userId, timestamp, timestamp);
  }

  async upsertSessionSync(data, userId) {
    const sid = data.session_id || data.sessionId;
    if (!sid) return null;
    const existing = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sid);
    const now = isoNow();
    if (existing) {
      const incUpdated = data.updated_at || data.updatedAt || now;
      const exUpdated = existing.updated_at;
      if (incUpdated >= exUpdated) {
        this.db.prepare(`UPDATE sessions SET title=?, status=?, updated_at=?, closed_at=?, deleted_at=NULL WHERE session_id=?`).run(
          data.title || existing.title, data.status || existing.status, incUpdated, data.closed_at || data.closedAt || null, sid);
      }
      return this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sid);
    }
    this.db.prepare(`INSERT INTO sessions (session_id, title, status, created_at, updated_at, closed_at, source_device_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sid, data.title || '', data.status || 'active', data.created_at || data.createdAt || now, data.updated_at || data.updatedAt || now, data.closed_at || data.closedAt || null, data.sourceDeviceId || data.source_device_id || null, userId);
    return this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sid);
  }

  async softDeleteSession(sessionId, deletedAt, userId) {
    this.db.prepare('UPDATE sessions SET deleted_at = ? WHERE session_id = ?').run(deletedAt || isoNow(), sessionId);
  }

  async findSessionsByStatus(status, userId) {
    return this.db.prepare('SELECT * FROM sessions WHERE status = ? AND user_id = ? AND deleted_at IS NULL').all(status, userId);
  }

  async findSessions(userId) {
    if (userId) {
      return this.db.prepare('SELECT * FROM sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(userId);
    }
    return this.db.prepare('SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY created_at DESC').all();
  }

  // ── HISTORY ──────────────────────────────────────────────────

  async findHistories(query = {}) {
    const where = ['deleted_at IS NULL'];
    const params = {};
    if (query.userId) { where.push('user_id = @userId'); params.userId = query.userId; }
    return this.db.prepare(`SELECT * FROM history WHERE ${where.join(' AND ')}`).all(params);
  }

  async findHistoryById(id) {
    return this._rowToObj(this.db.prepare('SELECT * FROM history WHERE id = ? OR sync_id = ?').get(id, id));
  }

  async createHistory(data) {
    const syncId = data.sync_id || data.syncId || generateSyncId('history');
    const now = isoNow();
    this.db.prepare(`INSERT INTO history (sync_id, name, logs_data, log_count, created_at, updated_at, source_device_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      syncId, data.name, data.logs_data || data.logsData || '[]', data.log_count || data.logCount || 0, now, now, data.sourceDeviceId || data.source_device_id || null, data.userId || data.user_id);
    return this.db.prepare('SELECT * FROM history WHERE sync_id = ?').get(syncId);
  }

  async updateHistory(id, data) {
    const now = isoNow();
    this.db.prepare('UPDATE history SET name=?, logs_data=?, log_count=?, updated_at=? WHERE id=? OR sync_id=?').run(
      data.name, data.logs_data || data.logsData, data.log_count || data.logCount, now, id, id);
    return this.db.prepare('SELECT * FROM history WHERE id = ? OR sync_id = ?').get(id, id);
  }

  async deleteHistory(id) {
    this.db.prepare('UPDATE history SET deleted_at = ? WHERE id = ? OR sync_id = ?').run(isoNow(), id, id);
    return true;
  }

  async findHistoriesSince(timestamp, userId) {
    return this.db.prepare('SELECT * FROM history WHERE user_id = ? AND (updated_at > ? OR deleted_at > ?)').all(userId, timestamp, timestamp);
  }

  async upsertHistorySync(data, userId) {
    const syncId = data.sync_id || data.syncId || data.id;
    const existing = syncId ? this.db.prepare('SELECT * FROM history WHERE sync_id = ?').get(syncId) : null;
    const now = isoNow();
    if (existing) {
      const inc = data.updated_at || data.updatedAt || now;
      if (inc >= existing.updated_at) {
        this.db.prepare('UPDATE history SET name=?, logs_data=?, log_count=?, updated_at=?, deleted_at=NULL WHERE sync_id=?').run(
          data.name || existing.name, data.logs_data || data.logsData || existing.logs_data, data.log_count ?? data.logCount ?? existing.log_count, inc, syncId);
      }
      return this.db.prepare('SELECT * FROM history WHERE sync_id = ?').get(syncId);
    }
    return this.createHistory({ ...data, userId });
  }

  async softDeleteHistory(id, deletedAt, userId) {
    this.db.prepare('UPDATE history SET deleted_at = ? WHERE sync_id = ?').run(deletedAt || isoNow(), id);
  }

  // ── CALLSIGN-QTH HISTORY ─────────────────────────────────────

  async findCallsignQthById(id) {
    return this._rowToObj(this.db.prepare('SELECT * FROM callsign_qth_history WHERE sync_id = ? OR id = ?').get(id, id));
  }

  async addCallsignQthRecord(callsign, qth, userId) {
    const syncId = generateSyncId('callsign-qth');
    const now = isoNow();
    this.db.prepare(`INSERT INTO callsign_qth_history (sync_id, callsign, qth, recorded_at, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      syncId, callsign.toUpperCase(), qth, now, now, now, userId);
    return this.db.prepare('SELECT * FROM callsign_qth_history WHERE sync_id = ?').get(syncId);
  }

  async getCallsignQthHistory(callsign, userId, limit = 3) {
    if (userId) {
      return this.db.prepare('SELECT * FROM callsign_qth_history WHERE callsign = ? AND user_id = ? AND deleted_at IS NULL ORDER BY recorded_at DESC LIMIT ?').all(callsign.toUpperCase(), userId, limit);
    }
    return this.db.prepare('SELECT * FROM callsign_qth_history WHERE callsign = ? AND deleted_at IS NULL ORDER BY recorded_at DESC LIMIT ?').all(callsign.toUpperCase(), limit);
  }

  async getAllCallsignQthHistory(userId) {
    if (userId) {
      return this.db.prepare('SELECT * FROM callsign_qth_history WHERE user_id = ? AND deleted_at IS NULL ORDER BY recorded_at DESC').all(userId);
    }
    return this.db.prepare('SELECT * FROM callsign_qth_history WHERE deleted_at IS NULL ORDER BY recorded_at DESC').all();
  }

  async clearCallsignQthHistory(userId) {
    this.db.prepare('UPDATE callsign_qth_history SET deleted_at = ? WHERE user_id = ?').run(isoNow(), userId);
  }

  async upsertCallsignQthSync(data, userId) {
    const syncId = data.sync_id || data.syncId || data.id;
    const existing = syncId ? this.db.prepare('SELECT * FROM callsign_qth_history WHERE sync_id = ?').get(syncId) : null;
    const now = isoNow();
    if (existing) {
      const inc = data.updated_at || data.updatedAt || now;
      this.db.prepare('UPDATE callsign_qth_history SET callsign=?, qth=?, recorded_at=?, updated_at=?, deleted_at=NULL WHERE sync_id=?').run(
        data.callsign || existing.callsign, data.qth || existing.qth, data.recorded_at || data.recordedAt || now, inc, syncId);
      return this.db.prepare('SELECT * FROM callsign_qth_history WHERE sync_id = ?').get(syncId);
    }
    return this.addCallsignQthRecord(data.callsign || '', data.qth || '', userId);
  }

  async findCallsignQthHistorySince(timestamp, userId) {
    return this.db.prepare('SELECT * FROM callsign_qth_history WHERE user_id = ? AND (updated_at > ? OR deleted_at > ?)').all(userId, timestamp, timestamp);
  }

  async softDeleteCallsignQth(id, deletedAt, userId) {
    this.db.prepare('UPDATE callsign_qth_history SET deleted_at = ? WHERE sync_id = ?').run(deletedAt || isoNow(), id);
  }

  // ── SHARES ───────────────────────────────────────────────────

  async findShares(query = {}) {
    const where = [];
    const params = {};
    if (query.fromUserId) { where.push('fromUserId = @fromUserId'); params.fromUserId = query.fromUserId; }
    if (query.toUserId) { where.push('toUserId = @toUserId'); params.toUserId = query.toUserId; }
    const sql = `SELECT * FROM shares${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    return this.db.prepare(sql).all(params);
  }

  async findShareById(id) {
    return this._rowToObj(this.db.prepare('SELECT * FROM shares WHERE id = ?').get(id));
  }

  async findShareByCode(shareCode) {
    return this._rowToObj(this.db.prepare("SELECT * FROM shares WHERE shareCode = ? AND status = 'pending'").get(shareCode));
  }

  async createShare(data) {
    const id = randomUUID();
    const shareCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    this.db.prepare('INSERT INTO shares (id, shareCode, fromUserId, toUserId, sessionId, permission, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, shareCode, data.fromUserId, data.toUserId || null, data.sessionId, data.permission || 'readwrite', 'pending', isoNow());
    return this.db.prepare('SELECT * FROM shares WHERE id = ?').get(id);
  }

  async updateShare(id, data) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(data)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    this.db.prepare(`UPDATE shares SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.db.prepare('SELECT * FROM shares WHERE id = ?').get(id);
  }

  async deleteShare(id) {
    const info = this.db.prepare('DELETE FROM shares WHERE id = ?').run(id);
    return info.changes > 0;
  }

  async findSharesForUser(userId) {
    return this.db.prepare('SELECT * FROM shares WHERE fromUserId = ? OR toUserId = ?').all(userId, userId);
  }

  async findSharedSessionIdsForUser(userId) {
    const shares = this.db.prepare("SELECT sessionId FROM shares WHERE toUserId = ? AND status = 'active'").all(userId);
    return [...new Set(shares.map(s => s.sessionId))];
  }

  async findSharedLogsSince(since, userId) {
    const sessionIds = await this.findSharedSessionIdsForUser(userId);
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM logs WHERE session_id IN (${placeholders}) AND deleted_at IS NULL AND updated_at > ?`).all(...sessionIds, since);
  }

  async findSharedSessionsSince(since, userId) {
    const sessionIds = await this.findSharedSessionIdsForUser(userId);
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM sessions WHERE session_id IN (${placeholders}) AND deleted_at IS NULL AND updated_at > ?`).all(...sessionIds, since);
  }

  async findSharedLogs_forRepo(fromUserId, toUserId) {
    const shares = this.db.prepare("SELECT sessionId FROM shares WHERE fromUserId = ? AND toUserId = ? AND status = 'active'").all(fromUserId, toUserId);
    if (shares.length === 0) return [];
    const sids = shares.map(s => s.sessionId);
    return this.db.prepare(`SELECT * FROM logs WHERE session_id IN (${sids.map(() => '?').join(',')}) AND deleted_at IS NULL`).all(...sids);
  }

  async findSharedDictionaries(fromUserId, toUserId) {
    return [];
  }

  // ── DEVICES ──────────────────────────────────────────────────

  async findDevices() {
    return this.db.prepare('SELECT * FROM devices').all();
  }

  async upsertDevice(deviceId, name) {
    const existing = this.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
    if (existing) {
      this.db.prepare('UPDATE devices SET name = ?, last_seen_at = ? WHERE device_id = ?').run(name, isoNow(), deviceId);
    } else {
      this.db.prepare('INSERT INTO devices (device_id, name, last_seen_at) VALUES (?, ?, ?)').run(deviceId, name, isoNow());
    }
    return this.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
  }

  // ── USERS ────────────────────────────────────────────────────

  async findUserById(id) {
    return this._rowToObj(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  async findUserByUsername(username) {
    return this._rowToObj(this.db.prepare('SELECT * FROM users WHERE username = ?').get(username));
  }

  async createUser(username, passwordHash, role = 'user', parentId = null, theme = 'light') {
    const id = randomUUID();
    this.db.prepare('INSERT INTO users (id, username, passwordHash, role, parentId, theme, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, username, passwordHash, role, parentId, theme, isoNow());
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  async updateUser(id, data) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(data)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  async deleteUser(id) {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return true;
  }

  async findUsersByParentId(parentId) {
    return this.db.prepare('SELECT * FROM users WHERE parentId = ?').all(parentId);
  }

  async findAllUsers() {
    return this.db.prepare('SELECT * FROM users').all();
  }

  // ── SYNC RECORDS ─────────────────────────────────────────────

  async createSyncRecord(deviceId, syncType, recordsCount, details = null) {
    this.db.prepare('INSERT INTO sync_records (device_id, sync_type, records_count, details, created_at) VALUES (?, ?, ?, ?, ?)').run(
      deviceId, syncType, recordsCount, details ? JSON.stringify(details) : null, isoNow());
  }

  async getSyncRecords(limit = 50) {
    return this.db.prepare('SELECT * FROM sync_records ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  // ── PUBLIC LINKS ─────────────────────────────────────────────

  async findPublicLinkByShareCode(code) {
    return this._rowToObj(this.db.prepare('SELECT * FROM public_links WHERE share_code = ? AND enabled = 1 AND revoked_at IS NULL').get(code));
  }

  async findPublicLinkBySession(sessionId, userId) {
    return this._rowToObj(this.db.prepare('SELECT * FROM public_links WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL').get(sessionId, userId));
  }

  async upsertPublicLink(data) {
    const _s = (v) => {
      if (v == null) return null;
      if (v instanceof Date) return v.toISOString();
      return String(v);
    };
    const sid = _s(data.session_id || data.sessionId);
    const uid = _s(data.user_id || data.userId);
    const existing = sid && uid
      ? this.db.prepare('SELECT * FROM public_links WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL').get(sid, uid)
      : null;
    const id = randomUUID();
    const shareCode = data.share_code || data.shareCode || randomUUID().substring(0, 12);
    const expiresAt = _s(data.expires_at || data.expiresAt);
    if (existing) {
      this.db.prepare('UPDATE public_links SET expires_at = ?, enabled = 1, revoked_at = NULL WHERE id = ?').run(
        expiresAt, existing.id);
      return this.db.prepare('SELECT * FROM public_links WHERE id = ?').get(existing.id);
    }
    this.db.prepare('INSERT INTO public_links (id, url, share_code, session_id, user_id, expires_at, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').run(
      id, data.url || '', shareCode, sid, uid, expiresAt, isoNow());
    return this.db.prepare('SELECT * FROM public_links WHERE id = ?').get(id);
  }

  async listAllPublicLinks() {
    return this.db.prepare('SELECT * FROM public_links WHERE revoked_at IS NULL ORDER BY created_at DESC').all();
  }

  async deletePublicLink(id) {
    this.db.prepare('DELETE FROM public_links WHERE id = ?').run(id);
  }

  async togglePublicLink(id, enabled) {
    this.db.prepare('UPDATE public_links SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  async revokePublicLink(id) {
    this.db.prepare('UPDATE public_links SET revoked_at = ? WHERE id = ?').run(isoNow(), id);
    return true;
  }
}
