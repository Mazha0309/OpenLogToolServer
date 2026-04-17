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

    // 初始化表结构
    await this._initTables();
    return this;
  }

  async _initTables() {
    const createLogsTable = `
      CREATE TABLE IF NOT EXISTS logs (
        id VARCHAR(36) PRIMARY KEY,
        device_id VARCHAR(64),
        log_time DATETIME NOT NULL,
        controller VARCHAR(100) NOT NULL,
        callsign VARCHAR(20) NOT NULL,
        report VARCHAR(500),
        qth VARCHAR(200),
        device VARCHAR(200),
        power VARCHAR(50),
        antenna VARCHAR(200),
        height VARCHAR(50),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_device_time (device_id, log_time),
        INDEX idx_callsign (callsign)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createDictionaryTable = `
      CREATE TABLE IF NOT EXISTS dictionaries (
        id VARCHAR(36) PRIMARY KEY,
        type ENUM('device', 'antenna', 'qth', 'callsign') NOT NULL,
        raw VARCHAR(200) NOT NULL,
        pinyin VARCHAR(200),
        abbreviation VARCHAR(50),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_type (type),
        UNIQUE INDEX idx_type_raw (type, raw)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createDevicesTable = `
      CREATE TABLE IF NOT EXISTS devices (
        id VARCHAR(36) PRIMARY KEY,
        device_id VARCHAR(64) UNIQUE NOT NULL,
        name VARCHAR(100),
        last_sync_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_device_id (device_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createUsersTable = `
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

    await this.pool.execute(createLogsTable);
    await this.pool.execute(createDictionaryTable);
    await this.pool.execute(createDevicesTable);
    await this.pool.execute(createUsersTable);
    await this.pool.execute(createSyncRecordsTable);
  }

  async disconnect() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  // 日志操作
  async findLogs(query = {}, pagination = { page: 1, pageSize: 20 }) {
    const { page, pageSize } = pagination;
    const offset = (page - 1) * pageSize;
    let whereClause = '1=1';
    const params = [];

    if (query.callsign) {
      whereClause += ' AND callsign LIKE ?';
      params.push(`%${query.callsign}%`);
    }
    if (query.controller) {
      whereClause += ' AND controller LIKE ?';
      params.push(`%${query.controller}%`);
    }
    if (query.deviceId) {
      whereClause += ' AND device_id = ?';
      params.push(query.deviceId);
    }

    const [rows] = await this.pool.execute(
      `SELECT * FROM logs WHERE ${whereClause} ORDER BY log_time DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const [countResult] = await this.pool.execute(
      `SELECT COUNT(*) as total FROM logs WHERE ${whereClause}`,
      params
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
    const now = new Date();
    await this.pool.execute(
      `INSERT INTO logs (id, device_id, log_time, controller, callsign, report, qth, device, power, antenna, height, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.deviceId, data.time, data.controller, data.callsign, data.report, data.qth, data.device, data.power, data.antenna, data.height, now, now]
    );
    return this.findLogById(id);
  }

  async updateLog(id, data) {
    const now = new Date();
    await this.pool.execute(
      `UPDATE logs SET log_time=?, controller=?, callsign=?, report=?, qth=?, device=?, power=?, antenna=?, height=?, updated_at=?
       WHERE id = ?`,
      [data.time, data.controller, data.callsign, data.report, data.qth, data.device, data.power, data.antenna, data.height, now, id]
    );
    return this.findLogById(id);
  }

  async deleteLog(id) {
    const [result] = await this.pool.execute('DELETE FROM logs WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async upsertLog(data, deviceId) {
    const existingLog = await this._findByLocalId(data.localId, deviceId);
    if (existingLog) {
      return this.updateLog(existingLog.id, data);
    }
    return this.createLog({ ...data, deviceId });
  }

  async findSince(deviceId, timestamp) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM logs WHERE device_id = ? AND updated_at > ? ORDER BY updated_at ASC',
      [deviceId, new Date(timestamp)]
    );
    return rows.map(this._mapLogRow);
  }

  async _findByLocalId(localId, deviceId) {
    // 本地 ID 映射逻辑
    return null;
  }

  _mapLogRow(row) {
    return {
      id: row.id,
      deviceId: row.device_id,
      time: row.log_time,
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

  // 词典操作
  async findDictionaries(type, query = {}) {
    let sql = 'SELECT * FROM dictionaries WHERE 1=1';
    const params = [];

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    if (query.search) {
      sql += ' AND (raw LIKE ? OR pinyin LIKE ? OR abbreviation LIKE ?)';
      params.push(`%${query.search}%`, `%${query.search}%`, `%${query.search}%`);
    }

    sql += ' ORDER BY raw ASC';

    const [rows] = await this.pool.execute(sql, params);
    return rows.map(this._mapDictionaryRow);
  }

  async findDictionaryById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM dictionaries WHERE id = ?', [id]);
    return rows.length > 0 ? this._mapDictionaryRow(rows[0]) : null;
  }

  async createDictionary(type, data) {
    const id = uuidv4();
    await this.pool.execute(
      'INSERT INTO dictionaries (id, type, raw, pinyin, abbreviation) VALUES (?, ?, ?, ?, ?)',
      [id, type, data.raw, data.pinyin, data.abbreviation]
    );
    return this.findDictionaryById(id);
  }

  async updateDictionary(id, data) {
    await this.pool.execute(
      'UPDATE dictionaries SET raw=?, pinyin=?, abbreviation=? WHERE id = ?',
      [data.raw, data.pinyin, data.abbreviation, id]
    );
    return this.findDictionaryById(id);
  }

  async deleteDictionary(id) {
    const [result] = await this.pool.execute('DELETE FROM dictionaries WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async bulkCreateDictionary(type, items) {
    const now = new Date();
    for (const item of items) {
      await this.pool.execute(
        'INSERT IGNORE INTO dictionaries (id, type, raw, pinyin, abbreviation, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [uuidv4(), type, item.raw, item.pinyin, item.abbreviation, now]
      );
    }
    return this.findDictionaries(type);
  }

  _mapDictionaryRow(row) {
    return {
      id: row.id,
      type: row.type,
      raw: row.raw,
      pinyin: row.pinyin,
      abbreviation: row.abbreviation,
      createdAt: row.created_at,
    };
  }

  // 设备操作
  async findDevices() {
    const [rows] = await this.pool.execute('SELECT * FROM devices ORDER BY last_sync_at DESC');
    return rows.map(row => ({
      id: row.id,
      deviceId: row.device_id,
      name: row.name,
      lastSyncAt: row.last_sync_at,
      createdAt: row.created_at,
    }));
  }

  async upsertDevice(deviceId, name) {
    const existing = await this._findDeviceByDeviceId(deviceId);
    if (existing) {
      await this.pool.execute(
        'UPDATE devices SET last_sync_at = NOW() WHERE device_id = ?',
        [deviceId]
      );
    } else {
      await this.pool.execute(
        'INSERT INTO devices (id, device_id, name, last_sync_at) VALUES (?, ?, ?, NOW())',
        [uuidv4(), deviceId, name || deviceId]
      );
    }
    return this._findDeviceByDeviceId(deviceId);
  }

  async _findDeviceByDeviceId(deviceId) {
    const [rows] = await this.pool.execute('SELECT * FROM devices WHERE device_id = ?', [deviceId]);
    return rows.length > 0 ? {
      id: rows[0].id,
      deviceId: rows[0].device_id,
      name: rows[0].name,
      lastSyncAt: rows[0].last_sync_at,
      createdAt: rows[0].created_at,
    } : null;
  }

  // 用户操作
  async findUserByUsername(username) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    return rows.length > 0 ? this._mapUserRow(rows[0]) : null;
  }

  async createUser(username, passwordHash) {
    const id = uuidv4();
    await this.pool.execute(
      'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)',
      [id, username, passwordHash]
    );
    return this.findUserByUsername(username);
  }

  _mapUserRow(row) {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      createdAt: row.created_at,
    };
  }

  // 统计操作
  async getStats() {
    const [logsCount] = await this.pool.execute('SELECT COUNT(*) as count FROM logs');
    const [dictCount] = await this.pool.execute('SELECT COUNT(*) as count FROM dictionaries');
    const [devicesCount] = await this.pool.execute('SELECT COUNT(*) as count FROM devices');

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [todayCount] = await this.pool.execute(
      'SELECT COUNT(*) as count FROM logs WHERE log_time >= ?',
      [today]
    );

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const [weekCount] = await this.pool.execute(
      'SELECT COUNT(*) as count FROM logs WHERE log_time >= ?',
      [weekAgo]
    );

    return {
      totalLogs: logsCount[0].count,
      totalDictionaries: dictCount[0].count,
      totalDevices: devicesCount[0].count,
      todayLogs: todayCount[0].count,
      weekLogs: weekCount[0].count,
    };
  }

  // 同步记录
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
    return rows.map(row => ({
      id: row.id,
      deviceId: row.device_id,
      syncType: row.sync_type,
      recordsCount: row.records_count,
      syncedAt: row.synced_at,
    }));
  }
}
