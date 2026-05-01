/**
 * @fileoverview MySQL 数据库适配器
 */

import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

const toDate = value => {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
};

const latestTimestamp = (...values) => {
  const dates = values
    .map(toDate)
    .filter(value => value instanceof Date && !Number.isNaN(value.getTime()));

  if (dates.length === 0) {
    return null;
  }

  return new Date(Math.max(...dates.map(value => value.getTime())));
};

const isIncomingNewer = (incomingUpdatedAt, existingUpdatedAt) => {
  const incoming = toDate(incomingUpdatedAt);
  const existing = toDate(existingUpdatedAt);

  if (!incoming || !existing) {
    return true;
  }

  return incoming.getTime() >= existing.getTime();
};

export class MysqlAdapter {
  constructor(config) {
    this.config = config;
    this.pool = null;
  }

  async connect() {
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    await this.initTables();

    const [rows] = await this.pool.execute('SELECT COUNT(*) as cnt FROM users WHERE username = ?', ['admin']);
    if (rows[0].cnt === 0) {
      const bcrypt = (await import('bcryptjs')).default;
      const hash = bcrypt.hashSync('admin123', 10);
      await this.pool.execute(
        'INSERT INTO users (id, username, password_hash, role) VALUES (UUID(), ?, ?, ?)',
        ['admin', hash, 'admin']
      );
    }

    return this;
  }

  async disconnect() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async _ensureColumn(tableName, columnName, definition) {
    const [rows] = await this.pool.execute(
      `SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [tableName, columnName]
    );

    if (rows[0].count === 0) {
      await this.pool.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  async initTables() {
    const createLogsTable = `
      CREATE TABLE IF NOT EXISTS logs (
        id VARCHAR(36) PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL,
        source_device_id VARCHAR(64) NULL,
        user_id VARCHAR(36) NOT NULL,
        local_id VARCHAR(64),
        time DATETIME NOT NULL,
        controller VARCHAR(64),
        callsign VARCHAR(64),
        report TEXT,
        qth VARCHAR(128),
        device VARCHAR(128),
        power VARCHAR(32),
        antenna VARCHAR(128),
        height VARCHAR(32),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME NULL,
        INDEX idx_device_user (device_id, user_id),
        INDEX idx_callsign (callsign),
        INDEX idx_updated (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createDictionaryTable = `
      CREATE TABLE IF NOT EXISTS dictionaries (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        type ENUM('device', 'antenna', 'qth', 'callsign') NOT NULL,
        raw VARCHAR(255) NOT NULL,
        pinyin VARCHAR(255),
        abbreviation VARCHAR(64),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME NULL,
        UNIQUE INDEX idx_user_type_raw (user_id, type, raw)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createDevicesTable = `
      CREATE TABLE IF NOT EXISTS devices (
        id VARCHAR(36) PRIMARY KEY,
        device_id VARCHAR(64) UNIQUE NOT NULL,
        name VARCHAR(128),
        last_sync_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_device_id (device_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createUsersTable = `
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY,
        username VARCHAR(64) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('admin', 'user') DEFAULT 'user',
        parent_id VARCHAR(36),
        theme VARCHAR(32) DEFAULT 'light',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_parent (parent_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createSyncRecordsTable = `
      CREATE TABLE IF NOT EXISTS sync_records (
        id VARCHAR(36) PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL,
        sync_type ENUM('push', 'pull', 'bidirectional') NOT NULL,
        records_count INT DEFAULT 0,
        details JSON NULL,
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_device_synced (device_id, synced_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createSharesTable = `
      CREATE TABLE IF NOT EXISTS shares (
        id VARCHAR(36) PRIMARY KEY,
        from_user_id VARCHAR(36) NOT NULL,
        to_user_id VARCHAR(36) NOT NULL,
        share_type ENUM('logs', 'dictionaries', 'both') NOT NULL,
        status ENUM('active', 'inactive') DEFAULT 'active',
        item_ids JSON,
        auto_sync BOOLEAN DEFAULT FALSE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_from_user (from_user_id),
        INDEX idx_to_user (to_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createCallsignQthHistoryTable = `
      CREATE TABLE IF NOT EXISTS callsign_qth_history (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        callsign VARCHAR(64) NOT NULL,
        qth VARCHAR(128) NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME NULL,
        INDEX idx_user_callsign (user_id, callsign),
        INDEX idx_timestamp (timestamp),
        INDEX idx_recorded_at (recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createHistoryTable = `
      CREATE TABLE IF NOT EXISTS history (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL,
        logs_data LONGTEXT NOT NULL,
        log_count INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME NULL,
        INDEX idx_history_user (user_id),
        INDEX idx_history_updated (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    await this.pool.execute(createLogsTable);
    await this.pool.execute(createDictionaryTable);
    await this.pool.execute(createDevicesTable);
    await this.pool.execute(createUsersTable);
    await this.pool.execute(createSyncRecordsTable);
    await this.pool.execute(createSharesTable);
    await this.pool.execute(createCallsignQthHistoryTable);
    await this.pool.execute(createHistoryTable);

    const createSessionsTable = `
      CREATE TABLE IF NOT EXISTS sessions (
        session_id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        status ENUM('active','closed','archived') NOT NULL DEFAULT 'active',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        closed_at DATETIME(3) NULL,
        deleted_at DATETIME(3) NULL,
        source_device_id VARCHAR(255) NULL,
        user_id VARCHAR(64) NULL,
        INDEX idx_sessions_status (status),
        INDEX idx_sessions_updated (updated_at),
        INDEX idx_sessions_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    await this.pool.execute(createSessionsTable);

    await this._ensureColumn('logs', 'source_device_id', 'VARCHAR(64) NULL AFTER device_id');
    await this._ensureColumn('logs', 'sync_id', 'VARCHAR(36) NULL AFTER id');
    await this._ensureColumn('logs', 'client_updated_at', 'DATETIME NULL AFTER updated_at');
    await this._ensureColumn('logs', 'server_updated_at', 'DATETIME NULL AFTER client_updated_at');
    await this._ensureColumn('logs', 'deleted_at', 'DATETIME NULL AFTER updated_at');
    await this._ensureColumn('logs', 'session_id', 'VARCHAR(64) NULL');
    await this.pool.execute('UPDATE logs SET source_device_id = COALESCE(source_device_id, device_id) WHERE source_device_id IS NULL');
    await this.pool.execute('UPDATE logs SET sync_id = COALESCE(sync_id, id) WHERE sync_id IS NULL');

    await this._ensureColumn('dictionaries', 'updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP AFTER created_at');
    await this._ensureColumn('dictionaries', 'sync_id', 'VARCHAR(36) NULL AFTER id');
    await this._ensureColumn('dictionaries', 'source_device_id', 'VARCHAR(64) NULL AFTER user_id');
    await this._ensureColumn('dictionaries', 'client_updated_at', 'DATETIME NULL AFTER updated_at');
    await this._ensureColumn('dictionaries', 'server_updated_at', 'DATETIME NULL AFTER client_updated_at');
    await this._ensureColumn('dictionaries', 'deleted_at', 'DATETIME NULL AFTER updated_at');
    await this.pool.execute('UPDATE dictionaries SET updated_at = COALESCE(updated_at, created_at, NOW()) WHERE updated_at IS NULL');
    await this.pool.execute('UPDATE dictionaries SET sync_id = COALESCE(sync_id, id) WHERE sync_id IS NULL');

    await this._ensureColumn('callsign_qth_history', 'recorded_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP AFTER timestamp');
    await this._ensureColumn('callsign_qth_history', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP AFTER recorded_at');
    await this._ensureColumn('callsign_qth_history', 'updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP AFTER created_at');
    await this._ensureColumn('callsign_qth_history', 'sync_id', 'VARCHAR(36) NULL AFTER id');
    await this._ensureColumn('callsign_qth_history', 'source_device_id', 'VARCHAR(64) NULL AFTER user_id');
    await this._ensureColumn('callsign_qth_history', 'client_updated_at', 'DATETIME NULL AFTER updated_at');
    await this._ensureColumn('callsign_qth_history', 'server_updated_at', 'DATETIME NULL AFTER client_updated_at');
    await this._ensureColumn('callsign_qth_history', 'deleted_at', 'DATETIME NULL AFTER updated_at');
    await this.pool.execute('UPDATE callsign_qth_history SET recorded_at = COALESCE(recorded_at, timestamp, NOW()) WHERE recorded_at IS NULL');
    await this.pool.execute('UPDATE callsign_qth_history SET sync_id = COALESCE(sync_id, id) WHERE sync_id IS NULL');

    await this._ensureColumn('history', 'sync_id', 'VARCHAR(36) NULL AFTER id');
    await this._ensureColumn('history', 'source_device_id', 'VARCHAR(64) NULL AFTER user_id');
    await this._ensureColumn('history', 'client_updated_at', 'DATETIME NULL AFTER updated_at');
    await this._ensureColumn('history', 'server_updated_at', 'DATETIME NULL AFTER client_updated_at');
    await this.pool.execute('UPDATE history SET sync_id = COALESCE(sync_id, id) WHERE sync_id IS NULL');

    await this._ensureColumn('sync_records', 'details', 'JSON NULL AFTER records_count');
    await this.pool.execute('UPDATE callsign_qth_history SET created_at = COALESCE(created_at, recorded_at, timestamp, NOW()) WHERE created_at IS NULL');
    await this.pool.execute('UPDATE callsign_qth_history SET updated_at = COALESCE(updated_at, recorded_at, timestamp, NOW()) WHERE updated_at IS NULL');
  }

  async findShares(query = {}) {
    let sql = 'SELECT * FROM shares WHERE 1=1';
    const params = [];

    if (query.fromUserId) {
      sql += ' AND from_user_id = ?';
      params.push(query.fromUserId);
    }
    if (query.toUserId) {
      sql += ' AND to_user_id = ?';
      params.push(query.toUserId);
    }

    const [rows] = await this.pool.execute(sql, params);
    return rows.map(this._mapShareRow);
  }

  async createShare(data) {
    const id = uuidv4();
    await this.pool.execute(
      'INSERT INTO shares (id, from_user_id, to_user_id, share_type, status, item_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [id, data.fromUserId, data.toUserId, data.shareType, data.status || 'active', JSON.stringify(data.itemIds)]
    );
    return this.findShareById(id);
  }

  async findShareById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM shares WHERE id = ?', [id]);
    return rows.length > 0 ? this._mapShareRow(rows[0]) : null;
  }

  async updateShare(id, data) {
    const updates = [];
    const params = [];

    if (data.shareType !== undefined) {
      updates.push('share_type = ?');
      params.push(data.shareType);
    }
    if (data.itemIds !== undefined) {
      updates.push('item_ids = ?');
      params.push(JSON.stringify(data.itemIds));
    }
    if (data.status !== undefined) {
      updates.push('status = ?');
      params.push(data.status);
    }
    if (data.autoSync !== undefined) {
      updates.push('auto_sync = ?');
      params.push(data.autoSync);
    }

    if (updates.length > 0) {
      params.push(id);
      await this.pool.execute(`UPDATE shares SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    return this.findShareById(id);
  }

  async deleteShare(id) {
    const [result] = await this.pool.execute('DELETE FROM shares WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async findSharedLogs(fromUserId, toUserId) {
    const [rows] = await this.pool.execute(
      "SELECT * FROM shares WHERE from_user_id = ? AND to_user_id = ? AND (share_type = 'logs' OR share_type = 'both')",
      [fromUserId, toUserId]
    );
    const itemIds = [];
    for (const row of rows) {
      if (row.item_ids == null) return null;
      if (Array.isArray(row.item_ids)) itemIds.push(...row.item_ids);
    }
    return itemIds;
  }

  async findSharedDictionaries(fromUserId, toUserId) {
    const [rows] = await this.pool.execute(
      "SELECT * FROM shares WHERE from_user_id = ? AND to_user_id = ? AND (share_type = 'dictionaries' OR share_type = 'both')",
      [fromUserId, toUserId]
    );
    const itemIds = [];
    for (const row of rows) {
      if (row.item_ids == null) return null;
      if (Array.isArray(row.item_ids)) itemIds.push(...row.item_ids);
    }
    return itemIds;
  }

  _mapShareRow(row) {
    return {
      id: row.id,
      fromUserId: row.from_user_id,
      toUserId: row.to_user_id,
      shareType: row.share_type,
      status: row.status,
      itemIds: row.item_ids,
      autoSync: row.auto_sync ?? false,
      createdAt: row.created_at,
    };
  }

  async findLogs(query = {}, pagination = {}) {
    let sql = 'SELECT * FROM logs WHERE 1=1';
    const params = [];
    const countConditions = [];
    const countParams = [];

    if (!query.includeDeleted) {
      sql += ' AND deleted_at IS NULL';
      countConditions.push('deleted_at IS NULL');
    }
    if (query.deviceId) {
      sql += ' AND device_id = ?';
      params.push(query.deviceId);
      countConditions.push('device_id = ?');
      countParams.push(query.deviceId);
    }
    if (query.userId) {
      sql += ' AND user_id = ?';
      params.push(query.userId);
      countConditions.push('user_id = ?');
      countParams.push(query.userId);
    }
    if (query.callsign) {
      sql += ' AND callsign LIKE ?';
      params.push(`%${query.callsign}%`);
      countConditions.push('callsign LIKE ?');
      countParams.push(`%${query.callsign}%`);
    }
    if (query.controller) {
      sql += ' AND controller LIKE ?';
      params.push(`%${query.controller}%`);
      countConditions.push('controller LIKE ?');
      countParams.push(`%${query.controller}%`);
    }

    sql += ' ORDER BY time DESC';

    const page = pagination.page || 1;
    const pageSize = pagination.pageSize || 20;
    sql += ' LIMIT ? OFFSET ?';
    params.push(pageSize, (page - 1) * pageSize);

    const [rows] = await this.pool.execute(sql, params);
    const countSql = `SELECT COUNT(*) as total FROM logs WHERE 1=1${countConditions.length ? ` AND ${countConditions.join(' AND ')}` : ''}`;
    const [countResult] = await this.pool.execute(countSql, countParams);

    return {
      data: rows.map(this._mapLogRow),
      total: countResult[0].total,
      page,
      pageSize,
    };
  }

  async findLogById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM logs WHERE id = ?', [id]);
    return rows.length > 0 ? this._mapLogRow(rows[0]) : null;
  }

  async createLog(data) {
    const id = data.id || uuidv4();
    const sourceDeviceId = data.sourceDeviceId ?? data.source_device_id ?? data.deviceId ?? null;
    const syncId = data.syncId ?? data.sync_id ?? id;
    const createdAt = toDate(data.createdAt) || new Date();
    const updatedAt = toDate(data.updatedAt) || createdAt;
    const clientUpdatedAt = toDate(data.clientUpdatedAt ?? data.client_updated_at);
    const serverUpdatedAt = new Date();
    const deletedAt = toDate(data.deletedAt);

    await this.pool.execute(
      `INSERT INTO logs (
        id, sync_id, device_id, source_device_id, user_id, local_id, time, controller, callsign, report, qth, device, power, antenna, height, created_at, updated_at, client_updated_at, server_updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        syncId,
        sourceDeviceId,
        sourceDeviceId,
        data.userId,
        data.localId,
        data.time,
        data.controller,
        data.callsign,
        data.report,
        data.qth,
        data.device,
        data.power,
        data.antenna,
        data.height,
        createdAt,
        updatedAt,
        clientUpdatedAt,
        serverUpdatedAt,
        deletedAt,
      ]
    );
    return this.findLogById(id);
  }

  async updateLog(id, data) {
    const fields = [];
    const params = [];

    if (data.sourceDeviceId !== undefined || data.source_device_id !== undefined || data.deviceId !== undefined) {
      const sourceDeviceId = data.sourceDeviceId ?? data.source_device_id ?? data.deviceId;
      fields.push('device_id = ?');
      fields.push('source_device_id = ?');
      params.push(sourceDeviceId, sourceDeviceId);
    }
    if (data.userId !== undefined) { fields.push('user_id = ?'); params.push(data.userId); }
    if (data.localId !== undefined) { fields.push('local_id = ?'); params.push(data.localId); }
    if (data.time !== undefined) { fields.push('time = ?'); params.push(data.time); }
    if (data.controller !== undefined) { fields.push('controller = ?'); params.push(data.controller); }
    if (data.callsign !== undefined) { fields.push('callsign = ?'); params.push(data.callsign); }
    if (data.report !== undefined) { fields.push('report = ?'); params.push(data.report); }
    if (data.qth !== undefined) { fields.push('qth = ?'); params.push(data.qth); }
    if (data.device !== undefined) { fields.push('device = ?'); params.push(data.device); }
    if (data.power !== undefined) { fields.push('power = ?'); params.push(data.power); }
    if (data.antenna !== undefined) { fields.push('antenna = ?'); params.push(data.antenna); }
    if (data.height !== undefined) { fields.push('height = ?'); params.push(data.height); }
    if (data.syncId !== undefined || data.sync_id !== undefined) { fields.push('sync_id = ?'); params.push(data.syncId ?? data.sync_id ?? id); }
    if (data.createdAt !== undefined) { fields.push('created_at = ?'); params.push(toDate(data.createdAt)); }
    if (data.updatedAt !== undefined) { fields.push('updated_at = ?'); params.push(toDate(data.updatedAt)); }
    if (data.clientUpdatedAt !== undefined || data.client_updated_at !== undefined) {
      fields.push('client_updated_at = ?');
      params.push(toDate(data.clientUpdatedAt ?? data.client_updated_at));
    }
    if (data.serverUpdatedAt !== undefined || data.server_updated_at !== undefined) {
      fields.push('server_updated_at = NOW()');
    }
    if (data.deletedAt !== undefined) { fields.push('deleted_at = ?'); params.push(toDate(data.deletedAt)); }

    if (fields.length > 0) {
      if (!fields.includes('server_updated_at = NOW()')) {
        fields.push('server_updated_at = NOW()');
      }
      params.push(id);
      await this.pool.execute(`UPDATE logs SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    return this.findLogById(id);
  }

  async deleteLog(id) {
    const [result] = await this.pool.execute('DELETE FROM logs WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async upsertLog(data, deviceId, userId) {
    return this.upsertLogSync(data, deviceId, userId);
  }

  async upsertLogSync(data, deviceId, userId) {
    let existing = data.id ? await this.findLogById(data.id) : null;

    if (!existing && data.localId) {
      const [rows] = await this.pool.execute(
        'SELECT * FROM logs WHERE local_id = ? AND device_id = ? LIMIT 1',
        [data.localId, data.sourceDeviceId ?? deviceId]
      );
      existing = rows.length > 0 ? this._mapLogRow(rows[0]) : null;
    }

    if (existing) {
      const incomingUpdatedAt = latestTimestamp(data.updatedAt, data.deletedAt, data.createdAt);
      const existingUpdatedAt = latestTimestamp(existing.updatedAt, existing.deletedAt, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }

      return this.updateLog(existing.id, {
        ...data,
        userId,
        sourceDeviceId: data.sourceDeviceId ?? deviceId,
      });
    }

    return this.createLog({
      ...data,
      userId,
      deviceId: data.sourceDeviceId ?? deviceId,
      sourceDeviceId: data.sourceDeviceId ?? deviceId,
    });
  }

  async findSince(deviceId, timestamp, userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM logs WHERE device_id = ? AND user_id = ? AND updated_at > ? ORDER BY updated_at ASC',
      [deviceId, userId, toDate(timestamp)]
    );
    return rows.map(this._mapLogRow);
  }

  async findLogsSince(timestamp, userId) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM logs
       WHERE user_id = ?
         AND GREATEST(
           COALESCE(updated_at, created_at),
           COALESCE(deleted_at, '1000-01-01 00:00:00'),
           COALESCE(created_at, updated_at)
         ) > ?
       ORDER BY GREATEST(
         COALESCE(updated_at, created_at),
         COALESCE(deleted_at, '1000-01-01 00:00:00'),
         COALESCE(created_at, updated_at)
       ) ASC`,
      [userId, toDate(timestamp)]
    );
    return rows.map(this._mapLogRow);
  }

  async softDeleteLog(id, deletedAt, userId) {
    const params = [toDate(deletedAt) || new Date(), toDate(deletedAt) || new Date(), id];
    let sql = 'UPDATE logs SET deleted_at = ?, updated_at = ? WHERE id = ?';
    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }
    const [result] = await this.pool.execute(sql, params);
    if (!result || result.affectedRows === 0) {
      return null;
    }
    return this.findLogById(id);
  }

  async findDictionaries(type, query = {}) {
    let sql = 'SELECT * FROM dictionaries WHERE 1=1';
    const params = [];

    if (!query.includeDeleted) {
      sql += ' AND deleted_at IS NULL';
    }
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    if (query.userId) {
      sql += ' AND user_id = ?';
      params.push(query.userId);
    }
    if (query.search) {
      sql += ' AND (raw LIKE ? OR pinyin LIKE ? OR abbreviation LIKE ?)';
      const s = `%${query.search}%`;
      params.push(s, s, s);
    }

    sql += ' ORDER BY raw ASC';

    const [rows] = await this.pool.execute(sql, params);
    return rows.map(this._mapDictRow);
  }

  async findDictionaryById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM dictionaries WHERE id = ?', [id]);
    return rows.length > 0 ? this._mapDictRow(rows[0]) : null;
  }

  async createDictionary(type, data) {
    const id = data.id || uuidv4();
    const syncId = data.syncId ?? data.sync_id ?? id;
    const sourceDeviceId = data.sourceDeviceId ?? data.source_device_id ?? null;
    const createdAt = toDate(data.createdAt) || new Date();
    const updatedAt = toDate(data.updatedAt) || createdAt;
    const clientUpdatedAt = toDate(data.clientUpdatedAt ?? data.client_updated_at);
    const serverUpdatedAt = new Date();
    const deletedAt = toDate(data.deletedAt);
    await this.pool.execute(
      'INSERT INTO dictionaries (id, sync_id, user_id, source_device_id, type, raw, pinyin, abbreviation, created_at, updated_at, client_updated_at, server_updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, syncId, data.userId, sourceDeviceId, type, data.raw, data.pinyin, data.abbreviation, createdAt, updatedAt, clientUpdatedAt, serverUpdatedAt, deletedAt]
    );
    return this.findDictionaryById(id);
  }

  async updateDictionary(id, data) {
    const fields = [];
    const params = [];

    if (data.userId !== undefined) { fields.push('user_id = ?'); params.push(data.userId); }
    if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type); }
    if (data.raw !== undefined) { fields.push('raw = ?'); params.push(data.raw); }
    if (data.pinyin !== undefined) { fields.push('pinyin = ?'); params.push(data.pinyin); }
    if (data.abbreviation !== undefined) { fields.push('abbreviation = ?'); params.push(data.abbreviation); }
    if (data.syncId !== undefined || data.sync_id !== undefined) { fields.push('sync_id = ?'); params.push(data.syncId ?? data.sync_id ?? id); }
    if (data.sourceDeviceId !== undefined || data.source_device_id !== undefined) {
      fields.push('source_device_id = ?');
      params.push(data.sourceDeviceId ?? data.source_device_id);
    }
    if (data.createdAt !== undefined) { fields.push('created_at = ?'); params.push(toDate(data.createdAt)); }
    if (data.updatedAt !== undefined) { fields.push('updated_at = ?'); params.push(toDate(data.updatedAt)); }
    if (data.clientUpdatedAt !== undefined || data.client_updated_at !== undefined) {
      fields.push('client_updated_at = ?');
      params.push(toDate(data.clientUpdatedAt ?? data.client_updated_at));
    }
    if (data.serverUpdatedAt !== undefined || data.server_updated_at !== undefined) {
      fields.push('server_updated_at = NOW()');
    }
    if (data.deletedAt !== undefined) { fields.push('deleted_at = ?'); params.push(toDate(data.deletedAt)); }

    if (fields.length > 0) {
      if (!fields.includes('server_updated_at = NOW()')) {
        fields.push('server_updated_at = NOW()');
      }
      params.push(id);
      await this.pool.execute(`UPDATE dictionaries SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    return this.findDictionaryById(id);
  }

  async deleteDictionary(id) {
    const [result] = await this.pool.execute('DELETE FROM dictionaries WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async bulkCreateDictionary(type, items) {
    for (const item of items) {
      await this.createDictionary(type, item);
    }
    return this.findDictionaries(type);
  }

  async bulkUpsertDictionary(items, userId) {
    for (const item of items) {
      await this.upsertDictionarySync(item, userId);
    }
  }

  async findDictionariesByUser(userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM dictionaries WHERE user_id = ? AND deleted_at IS NULL ORDER BY raw ASC',
      [userId]
    );
    return rows.map(this._mapDictRow);
  }

  async findDictionariesSince(timestamp, userId) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM dictionaries
       WHERE user_id = ?
         AND GREATEST(
           COALESCE(updated_at, created_at),
           COALESCE(deleted_at, '1000-01-01 00:00:00'),
           COALESCE(created_at, updated_at)
         ) > ?
       ORDER BY GREATEST(
         COALESCE(updated_at, created_at),
         COALESCE(deleted_at, '1000-01-01 00:00:00'),
         COALESCE(created_at, updated_at)
       ) ASC`,
      [userId, toDate(timestamp)]
    );
    return rows.map(this._mapDictRow);
  }

  async upsertDictionarySync(item, userId) {
    let existing = item.id ? await this.findDictionaryById(item.id) : null;

    if (!existing) {
      const [rows] = await this.pool.execute(
        'SELECT * FROM dictionaries WHERE user_id = ? AND type = ? AND raw = ? LIMIT 1',
        [userId, item.type, item.raw]
      );
      existing = rows.length > 0 ? this._mapDictRow(rows[0]) : null;
    }

    if (existing) {
      const incomingUpdatedAt = latestTimestamp(item.updatedAt, item.deletedAt, item.createdAt);
      const existingUpdatedAt = latestTimestamp(existing.updatedAt, existing.deletedAt, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }

      return this.updateDictionary(existing.id, { ...item, userId, type: item.type ?? existing.type });
    }

    return this.createDictionary(item.type, { ...item, userId });
  }

  async softDeleteDictionary(id, deletedAt, userId) {
    const params = [toDate(deletedAt) || new Date(), toDate(deletedAt) || new Date(), id];
    let sql = 'UPDATE dictionaries SET deleted_at = ?, updated_at = ? WHERE id = ?';
    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }
    const [result] = await this.pool.execute(sql, params);
    if (!result || result.affectedRows === 0) {
      return null;
    }
    return this.findDictionaryById(id);
  }

  async addCallsignQthRecord(callsign, qth, userId) {
    const normalizedCallsign = callsign.toUpperCase();
    const [existingRows] = await this.pool.execute(
      'SELECT * FROM callsign_qth_history WHERE callsign = ? AND qth = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1',
      [normalizedCallsign, qth, userId]
    );

    if (existingRows.length > 0) {
      const now = new Date();
      await this.pool.execute(
        'UPDATE callsign_qth_history SET timestamp = ?, recorded_at = ?, updated_at = ?, server_updated_at = NOW(), deleted_at = NULL WHERE id = ?',
        [now, now, now, existingRows[0].id]
      );
      return this.findCallsignQthById(existingRows[0].id);
    }

    const id = uuidv4();
    const now = new Date();
    const syncId = id;
    const serverUpdatedAt = new Date();
    await this.pool.execute(
      'INSERT INTO callsign_qth_history (id, sync_id, user_id, source_device_id, callsign, qth, timestamp, recorded_at, created_at, updated_at, client_updated_at, server_updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, syncId, userId, null, normalizedCallsign, qth, now, now, now, now, null, serverUpdatedAt, null]
    );
    return this.findCallsignQthById(id);
  }

  async findCallsignQthById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM callsign_qth_history WHERE id = ?', [id]);
    return rows.length > 0 ? this._mapCallsignQthRow(rows[0]) : null;
  }

  async getCallsignQthHistory(callsign, userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM callsign_qth_history WHERE callsign = ? AND user_id = ? AND deleted_at IS NULL ORDER BY recorded_at DESC',
      [callsign.toUpperCase(), userId]
    );
    return rows.map(this._mapCallsignQthRow);
  }

  async getAllCallsignQthHistory(userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM callsign_qth_history WHERE user_id = ? AND deleted_at IS NULL ORDER BY recorded_at DESC',
      [userId]
    );
    return rows.map(this._mapCallsignQthRow);
  }

  async clearCallsignQthHistory(userId) {
    await this.pool.execute('DELETE FROM callsign_qth_history WHERE user_id = ?', [userId]);
  }

  async findCallsignQthHistorySince(timestamp, userId) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM callsign_qth_history
       WHERE user_id = ?
         AND GREATEST(
           COALESCE(updated_at, created_at),
           COALESCE(deleted_at, '1000-01-01 00:00:00'),
           COALESCE(recorded_at, timestamp, created_at),
           COALESCE(created_at, updated_at)
         ) > ?
       ORDER BY GREATEST(
         COALESCE(updated_at, created_at),
         COALESCE(deleted_at, '1000-01-01 00:00:00'),
         COALESCE(recorded_at, timestamp, created_at),
         COALESCE(created_at, updated_at)
       ) ASC`,
      [userId, toDate(timestamp)]
    );
    return rows.map(this._mapCallsignQthRow);
  }

  async upsertCallsignQthSync(record, userId) {
    let existing = record.id ? await this.findCallsignQthById(record.id) : null;

    if (!existing) {
      const [rows] = await this.pool.execute(
        'SELECT * FROM callsign_qth_history WHERE user_id = ? AND callsign = ? AND qth = ? LIMIT 1',
        [userId, record.callsign.toUpperCase(), record.qth]
      );
      existing = rows.length > 0 ? this._mapCallsignQthRow(rows[0]) : null;
    }

    if (existing) {
      const incomingUpdatedAt = latestTimestamp(record.updatedAt, record.deletedAt, record.recordedAt, record.timestamp, record.createdAt);
      const existingUpdatedAt = latestTimestamp(existing.updatedAt, existing.deletedAt, existing.recordedAt, existing.timestamp, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }

       await this.pool.execute(
         `UPDATE callsign_qth_history
         SET sync_id = ?, user_id = ?, source_device_id = ?, callsign = ?, qth = ?, timestamp = ?, recorded_at = ?, created_at = ?, updated_at = ?, client_updated_at = ?, server_updated_at = NOW(), deleted_at = ?
         WHERE id = ?`,
         [
           record.syncId ?? record.sync_id ?? existing.syncId ?? existing.id,
           userId,
           record.sourceDeviceId ?? record.source_device_id ?? existing.sourceDeviceId ?? null,
           record.callsign.toUpperCase(),
           record.qth,
           toDate(record.timestamp) || toDate(record.recordedAt) || new Date(),
           toDate(record.recordedAt) || toDate(record.timestamp) || new Date(),
           toDate(record.createdAt) || existing.createdAt || new Date(),
           toDate(record.updatedAt) || new Date(),
           toDate(record.clientUpdatedAt ?? record.client_updated_at),
           toDate(record.deletedAt),
           existing.id,
         ]
       );
      return this.findCallsignQthById(existing.id);
    }

    const id = record.id || uuidv4();
    const syncId = record.syncId ?? record.sync_id ?? id;
    const serverUpdatedAt = new Date();
    await this.pool.execute(
      'INSERT INTO callsign_qth_history (id, sync_id, user_id, source_device_id, callsign, qth, timestamp, recorded_at, created_at, updated_at, client_updated_at, server_updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        syncId,
        userId,
        record.sourceDeviceId ?? record.source_device_id ?? null,
        record.callsign.toUpperCase(),
        record.qth,
        toDate(record.timestamp) || toDate(record.recordedAt) || new Date(),
        toDate(record.recordedAt) || toDate(record.timestamp) || new Date(),
        toDate(record.createdAt) || new Date(),
        toDate(record.updatedAt) || new Date(),
        toDate(record.clientUpdatedAt ?? record.client_updated_at),
        serverUpdatedAt,
        toDate(record.deletedAt),
      ]
    );
    return this.findCallsignQthById(id);
  }

  async softDeleteCallsignQth(id, deletedAt, userId) {
    const params = [toDate(deletedAt) || new Date(), toDate(deletedAt) || new Date(), id];
    let sql = 'UPDATE callsign_qth_history SET deleted_at = ?, updated_at = ? WHERE id = ?';
    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }
    const [result] = await this.pool.execute(sql, params);
    if (!result || result.affectedRows === 0) {
      return null;
    }
    return this.findCallsignQthById(id);
  }

  async findHistories(query = {}) {
    let sql = 'SELECT * FROM history WHERE 1=1';
    const params = [];

    if (query.userId) {
      sql += ' AND user_id = ?';
      params.push(query.userId);
    }
    if (!query.includeDeleted) {
      sql += ' AND deleted_at IS NULL';
    }

    sql += ' ORDER BY updated_at DESC';
    const [rows] = await this.pool.execute(sql, params);
    return rows.map(this._mapHistoryRow);
  }

  async findHistoryById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM history WHERE id = ?', [id]);
    return rows.length > 0 ? this._mapHistoryRow(rows[0]) : null;
  }

  async createHistory(data) {
    const id = data.id || uuidv4();
    const syncId = data.syncId ?? data.sync_id ?? id;
    const sourceDeviceId = data.sourceDeviceId ?? data.source_device_id ?? null;
    const createdAt = toDate(data.createdAt) || new Date();
    const updatedAt = toDate(data.updatedAt) || createdAt;
    const clientUpdatedAt = toDate(data.clientUpdatedAt ?? data.client_updated_at);
    const serverUpdatedAt = new Date();
    await this.pool.execute(
      'INSERT INTO history (id, sync_id, user_id, source_device_id, name, logs_data, log_count, created_at, updated_at, client_updated_at, server_updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, syncId, data.userId, sourceDeviceId, data.name, data.logsData, data.logCount ?? 0, createdAt, updatedAt, clientUpdatedAt, serverUpdatedAt, toDate(data.deletedAt)]
    );
    return this.findHistoryById(id);
  }

  async updateHistory(id, data) {
    const fields = [];
    const params = [];

    if (data.userId !== undefined) { fields.push('user_id = ?'); params.push(data.userId); }
    if (data.syncId !== undefined || data.sync_id !== undefined) { fields.push('sync_id = ?'); params.push(data.syncId ?? data.sync_id ?? id); }
    if (data.sourceDeviceId !== undefined || data.source_device_id !== undefined) {
      fields.push('source_device_id = ?');
      params.push(data.sourceDeviceId ?? data.source_device_id);
    }
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
    if (data.logsData !== undefined) { fields.push('logs_data = ?'); params.push(data.logsData); }
    if (data.logCount !== undefined) { fields.push('log_count = ?'); params.push(data.logCount); }
    if (data.createdAt !== undefined) { fields.push('created_at = ?'); params.push(toDate(data.createdAt)); }
    if (data.updatedAt !== undefined) { fields.push('updated_at = ?'); params.push(toDate(data.updatedAt)); }
    if (data.clientUpdatedAt !== undefined || data.client_updated_at !== undefined) {
      fields.push('client_updated_at = ?');
      params.push(toDate(data.clientUpdatedAt ?? data.client_updated_at));
    }
    if (data.serverUpdatedAt !== undefined || data.server_updated_at !== undefined) {
      fields.push('server_updated_at = NOW()');
    }
    if (data.deletedAt !== undefined) { fields.push('deleted_at = ?'); params.push(toDate(data.deletedAt)); }

    if (fields.length > 0) {
      if (!fields.includes('server_updated_at = NOW()')) {
        fields.push('server_updated_at = NOW()');
      }
      params.push(id);
      await this.pool.execute(`UPDATE history SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    return this.findHistoryById(id);
  }

  async deleteHistory(id) {
    const [result] = await this.pool.execute('DELETE FROM history WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async findHistoriesSince(timestamp, userId) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM history
       WHERE user_id = ?
         AND GREATEST(
           COALESCE(updated_at, created_at),
           COALESCE(deleted_at, '1000-01-01 00:00:00'),
           COALESCE(created_at, updated_at)
         ) > ?
       ORDER BY GREATEST(
         COALESCE(updated_at, created_at),
         COALESCE(deleted_at, '1000-01-01 00:00:00'),
         COALESCE(created_at, updated_at)
       ) ASC`,
      [userId, toDate(timestamp)]
    );
    return rows.map(this._mapHistoryRow);
  }

  async upsertHistorySync(data, userId) {
    const existing = data.id ? await this.findHistoryById(data.id) : null;

    if (existing) {
      const incomingUpdatedAt = latestTimestamp(data.updatedAt, data.deletedAt, data.createdAt);
      const existingUpdatedAt = latestTimestamp(existing.updatedAt, existing.deletedAt, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }

      return this.updateHistory(existing.id, { ...data, userId });
    }

    return this.createHistory({ ...data, userId });
  }

  async softDeleteHistory(id, deletedAt, userId) {
    const params = [toDate(deletedAt) || new Date(), toDate(deletedAt) || new Date(), id];
    let sql = 'UPDATE history SET deleted_at = ?, updated_at = ? WHERE id = ?';
    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }
    const [result] = await this.pool.execute(sql, params);
    if (!result || result.affectedRows === 0) {
      return null;
    }
    return this.findHistoryById(id);
  }

  async findSessionById(sessionId) {
    const [rows] = await this.pool.execute('SELECT * FROM sessions WHERE session_id = ?', [sessionId]);
    return rows.length > 0 ? this._mapSessionRow(rows[0]) : null;
  }

  async findSessionsSince(timestamp, userId) {
    let sql = `SELECT * FROM sessions
       WHERE GREATEST(
         COALESCE(updated_at, created_at),
         COALESCE(deleted_at, '1000-01-01 00:00:00')
       ) > ?`;
    const params = [toDate(timestamp)];

    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }

    sql += ` ORDER BY GREATEST(
         COALESCE(updated_at, created_at),
         COALESCE(deleted_at, '1000-01-01 00:00:00')
       ) ASC`;

    const [rows] = await this.pool.execute(sql, params);
    return rows.map(this._mapSessionRow);
  }

  async findSessionsByStatus(status, userId) {
    let sql = 'SELECT * FROM sessions WHERE status = ? AND deleted_at IS NULL';
    const params = [status];

    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }

    const [rows] = await this.pool.execute(sql, params);
    return rows.map(this._mapSessionRow);
  }

  async findSessions(userId) {
    let sql = 'SELECT * FROM sessions WHERE deleted_at IS NULL';
    const params = [];

    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }

    const [rows] = await this.pool.execute(sql, params);
    return rows.map(this._mapSessionRow);
  }

  async upsertSessionSync(data, userId) {
    const [existingRows] = await this.pool.execute(
      'SELECT * FROM sessions WHERE session_id = ?',
      [data.session_id]
    );
    const existing = existingRows.length > 0 ? this._mapSessionRow(existingRows[0]) : null;

    if (existing) {
      const incomingUpdatedAt = latestTimestamp(data.updated_at, data.deleted_at, data.created_at);
      const existingUpdatedAt = latestTimestamp(existing.updated_at, existing.deleted_at, existing.created_at);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }

      await this.pool.execute(
        `UPDATE sessions SET
          title = ?, status = ?, created_at = ?, updated_at = ?,
          closed_at = ?, deleted_at = ?, source_device_id = ?, user_id = ?
         WHERE session_id = ?`,
        [
          data.title,
          data.status ?? existing.status,
          toDate(data.created_at) || existing.created_at,
          toDate(data.updated_at) || new Date(),
          toDate(data.closed_at) ?? existing.closed_at,
          toDate(data.deleted_at) ?? existing.deleted_at,
          data.source_device_id ?? existing.source_device_id,
          userId,
          data.session_id,
        ]
      );
      return this.findSessionById(data.session_id);
    }

    await this.pool.execute(
      `INSERT INTO sessions (
        session_id, title, status, created_at, updated_at, closed_at, deleted_at, source_device_id, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.session_id,
        data.title,
        data.status ?? 'active',
        toDate(data.created_at) || new Date(),
        toDate(data.updated_at) || toDate(data.created_at) || new Date(),
        toDate(data.closed_at),
        toDate(data.deleted_at),
        data.source_device_id ?? null,
        userId,
      ]
    );
    return this.findSessionById(data.session_id);
  }

  async softDeleteSession(sessionId, deletedAt, userId) {
    const params = [toDate(deletedAt) || new Date(), toDate(deletedAt) || new Date(), sessionId];
    let sql = 'UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE session_id = ?';
    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }
    await this.pool.execute(sql, params);
  }

  async findDevices() {
    const [rows] = await this.pool.execute('SELECT * FROM devices ORDER BY last_sync_at DESC');
    return rows.map(this._mapDeviceRow);
  }

  async upsertDevice(deviceId, name) {
    const [existing] = await this.pool.execute('SELECT * FROM devices WHERE device_id = ?', [deviceId]);
    if (existing.length > 0) {
      await this.pool.execute(
        'UPDATE devices SET last_sync_at = NOW(), name = ? WHERE device_id = ?',
        [name || existing[0].name || deviceId, deviceId]
      );
      const [rows] = await this.pool.execute('SELECT * FROM devices WHERE device_id = ?', [deviceId]);
      return this._mapDeviceRow(rows[0]);
    }
    const id = uuidv4();
    await this.pool.execute(
      'INSERT INTO devices (id, device_id, name, last_sync_at) VALUES (?, ?, ?, NOW())',
      [id, deviceId, name || deviceId]
    );
    const [rows] = await this.pool.execute('SELECT * FROM devices WHERE id = ?', [id]);
    return this._mapDeviceRow(rows[0]);
  }

  async createSyncRecord(deviceId, syncType, recordsCount, details = null) {
    const id = uuidv4();
    await this.pool.execute(
      'INSERT INTO sync_records (id, device_id, sync_type, records_count, details, synced_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [id, deviceId, syncType, recordsCount, details ? JSON.stringify(details) : null]
    );
  }

  async getSyncRecords(limit = 50) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM sync_records ORDER BY synced_at DESC LIMIT ?',
      [limit]
    );
    return rows.map(r => ({
      id: r.id,
      deviceId: r.device_id,
      syncType: r.sync_type,
      recordsCount: r.records_count,
      details: r.details ? (typeof r.details === 'string' ? JSON.parse(r.details) : r.details) : null,
      syncedAt: r.synced_at,
    }));
  }

  _mapLogRow(row) {
    return {
      id: row.id,
      syncId: row.sync_id ?? row.id,
      deviceId: row.device_id,
      sourceDeviceId: row.source_device_id ?? row.device_id,
      userId: row.user_id,
      localId: row.local_id,
      time: row.time,
      controller: row.controller,
      callsign: row.callsign,
      report: row.report,
      qth: row.qth,
      device: row.device,
      power: row.power,
      antenna: row.antenna,
      height: row.height,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      clientUpdatedAt: row.client_updated_at,
      serverUpdatedAt: row.server_updated_at,
      deletedAt: row.deleted_at,
    };
  }

  _mapDictRow(row) {
    return {
      id: row.id,
      syncId: row.sync_id ?? row.id,
      userId: row.user_id,
      sourceDeviceId: row.source_device_id,
      type: row.type,
      raw: row.raw,
      pinyin: row.pinyin,
      abbreviation: row.abbreviation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      clientUpdatedAt: row.client_updated_at,
      serverUpdatedAt: row.server_updated_at,
      deletedAt: row.deleted_at,
    };
  }

  _mapCallsignQthRow(row) {
    return {
      id: row.id,
      syncId: row.sync_id ?? row.id,
      userId: row.user_id,
      sourceDeviceId: row.source_device_id,
      callsign: row.callsign,
      qth: row.qth,
      timestamp: row.timestamp,
      recordedAt: row.recorded_at ?? row.timestamp,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      clientUpdatedAt: row.client_updated_at,
      serverUpdatedAt: row.server_updated_at,
      deletedAt: row.deleted_at,
    };
  }

  _mapHistoryRow(row) {
    return {
      id: row.id,
      syncId: row.sync_id ?? row.id,
      userId: row.user_id,
      sourceDeviceId: row.source_device_id,
      name: row.name,
      logsData: row.logs_data,
      logCount: row.log_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      clientUpdatedAt: row.client_updated_at,
      serverUpdatedAt: row.server_updated_at,
      deletedAt: row.deleted_at,
    };
  }

  _mapSessionRow(row) {
    return {
      session_id: row.session_id,
      title: row.title,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      closed_at: row.closed_at,
      deleted_at: row.deleted_at,
      source_device_id: row.source_device_id,
      user_id: row.user_id,
    };
  }

  _mapDeviceRow(row) {
    return {
      id: row.id,
      deviceId: row.device_id,
      name: row.name,
      lastSyncAt: row.last_sync_at,
      createdAt: row.created_at,
    };
  }
}
