/**
 * @fileoverview MySQL 数据库适配器
 */

import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

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
      createdAt: row.created_at,
    };
  }

  async initTables() {
    const createLogsTable = `
      CREATE TABLE IF NOT EXISTS logs (
        id VARCHAR(36) PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_from_user (from_user_id),
        INDEX idx_to_user (to_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    await this.pool.execute(createLogsTable);
    await this.pool.execute(createDictionaryTable);
    await this.pool.execute(createDevicesTable);
    await this.pool.execute(createUsersTable);
    await this.pool.execute(createSyncRecordsTable);
    await this.pool.execute(createSharesTable);
  }

  async findLogs(query = {}, pagination = {}) {
    let sql = 'SELECT * FROM logs WHERE 1=1';
    const params = [];

    if (query.deviceId) {
      sql += ' AND device_id = ?';
      params.push(query.deviceId);
    }
    if (query.userId) {
      sql += ' AND user_id = ?';
      params.push(query.userId);
    }
    if (query.callsign) {
      sql += ' AND callsign LIKE ?';
      params.push(`%${query.callsign}%`);
    }
    if (query.controller) {
      sql += ' AND controller LIKE ?';
      params.push(`%${query.controller}%`);
    }

    sql += ' ORDER BY time DESC';

    const page = pagination.page || 1;
    const pageSize = pagination.pageSize || 20;
    sql += ' LIMIT ? OFFSET ?';
    params.push(pageSize, (page - 1) * pageSize);

    const [rows] = await this.pool.execute(sql, params);

    const [countResult] = await this.pool.execute(
      `SELECT COUNT(*) as total FROM logs WHERE 1=1${query.deviceId ? ' AND device_id = ?' : ''}${query.userId ? ' AND user_id = ?' : ''}`,
      params.slice(0, -2)
    );

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
    const id = uuidv4();
    await this.pool.execute(
      `INSERT INTO logs (id, device_id, user_id, local_id, time, controller, callsign, report, qth, device, power, antenna, height)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.deviceId, data.userId, data.localId, data.time, data.controller, data.callsign, data.report, data.qth, data.device, data.power, data.antenna, data.height]
    );
    return this.findLogById(id);
  }

  async updateLog(id, data) {
    const fields = [];
    const params = [];

    if (data.time !== undefined) { fields.push('time = ?'); params.push(data.time); }
    if (data.controller !== undefined) { fields.push('controller = ?'); params.push(data.controller); }
    if (data.callsign !== undefined) { fields.push('callsign = ?'); params.push(data.callsign); }
    if (data.report !== undefined) { fields.push('report = ?'); params.push(data.report); }
    if (data.qth !== undefined) { fields.push('qth = ?'); params.push(data.qth); }
    if (data.device !== undefined) { fields.push('device = ?'); params.push(data.device); }
    if (data.power !== undefined) { fields.push('power = ?'); params.push(data.power); }
    if (data.antenna !== undefined) { fields.push('antenna = ?'); params.push(data.antenna); }
    if (data.height !== undefined) { fields.push('height = ?'); params.push(data.height); }

    if (fields.length > 0) {
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
    let existing = null;
    if (data.localId) {
      const [rows] = await this.pool.execute(
        'SELECT * FROM logs WHERE local_id = ? AND device_id = ?',
        [data.localId, deviceId]
      );
      if (rows.length > 0) existing = rows[0];
    }

    if (existing) {
      return this.updateLog(existing.id, data);
    }
    return this.createLog({ ...data, deviceId, userId });
  }

  async findSince(deviceId, timestamp, userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM logs WHERE device_id = ? AND user_id = ? AND updated_at > ? ORDER BY updated_at ASC',
      [deviceId, userId, new Date(timestamp)]
    );
    return rows.map(this._mapLogRow);
  }

  async findDictionaries(type, query = {}) {
    let sql = 'SELECT * FROM dictionaries WHERE 1=1';
    const params = [];

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
    const id = uuidv4();
    await this.pool.execute(
      'INSERT INTO dictionaries (id, user_id, type, raw, pinyin, abbreviation) VALUES (?, ?, ?, ?, ?, ?)',
      [id, data.userId, type, data.raw, data.pinyin, data.abbreviation]
    );
    return this.findDictionaryById(id);
  }

  async updateDictionary(id, data) {
    const fields = [];
    const params = [];

    if (data.raw !== undefined) { fields.push('raw = ?'); params.push(data.raw); }
    if (data.pinyin !== undefined) { fields.push('pinyin = ?'); params.push(data.pinyin); }
    if (data.abbreviation !== undefined) { fields.push('abbreviation = ?'); params.push(data.abbreviation); }

    if (fields.length > 0) {
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
      const [existing] = await this.pool.execute(
        'SELECT * FROM dictionaries WHERE raw = ? AND type = ? AND user_id = ?',
        [item.raw, item.type, userId]
      );
      if (existing.length > 0) {
        await this.updateDictionary(existing[0].id, item);
      } else {
        await this.createDictionary(item.type, { ...item, userId });
      }
    }
  }

  async findDictionariesByUser(userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM dictionaries WHERE user_id = ? ORDER BY raw ASC',
      [userId]
    );
    return rows.map(this._mapDictRow);
  }

  async findDevices() {
    const [rows] = await this.pool.execute('SELECT * FROM devices ORDER BY last_sync_at DESC');
    return rows.map(this._mapDeviceRow);
  }

  async upsertDevice(deviceId, name) {
    const [existing] = await this.pool.execute('SELECT * FROM devices WHERE device_id = ?', [deviceId]);
    if (existing.length > 0) {
      await this.pool.execute(
        'UPDATE devices SET last_sync_at = NOW() WHERE device_id = ?',
        [deviceId]
      );
      return this._mapDeviceRow(existing[0]);
    }
    const id = uuidv4();
    await this.pool.execute(
      'INSERT INTO devices (id, device_id, name, last_sync_at) VALUES (?, ?, ?, NOW())',
      [id, deviceId, name || deviceId]
    );
    const [rows] = await this.pool.execute('SELECT * FROM devices WHERE id = ?', [id]);
    return this._mapDeviceRow(rows[0]);
  }

  async createSyncRecord(deviceId, syncType, recordsCount) {
    const id = uuidv4();
    await this.pool.execute(
      'INSERT INTO sync_records (id, device_id, sync_type, records_count, synced_at) VALUES (?, ?, ?, ?, NOW())',
      [id, deviceId, syncType, recordsCount]
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
      syncedAt: r.synced_at,
    }));
  }

  _mapLogRow(row) {
    return {
      id: row.id,
      deviceId: row.device_id,
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
    };
  }

  _mapDictRow(row) {
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type,
      raw: row.raw,
      pinyin: row.pinyin,
      abbreviation: row.abbreviation,
      createdAt: row.created_at,
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
