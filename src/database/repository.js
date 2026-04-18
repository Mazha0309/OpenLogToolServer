/**
 * @fileoverview 数据仓储层
 * @description 封装数据库操作，提供统一的接口
 */

export class LogRepository {
  constructor(adapter) {
    this.adapter = adapter;
  }

  /**
   * 分页查询日志
   * @param {Object} query - 查询条件
   * @param {Object} pagination - 分页参数
   * @returns {Promise<{data: Array, total: number, page: number, pageSize: number}>}
   */
  async findAll(query = {}, pagination = { page: 1, pageSize: 20 }) {
    return this.adapter.findLogs(query, pagination);
  }

  /**
   * 根据 ID 查询日志
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async findById(id) {
    return this.adapter.findLogById(id);
  }

  /**
   * 创建日志
   * @param {Object} data
   * @returns {Promise<Object>}
   */
  async create(data) {
    return this.adapter.createLog(data);
  }

  /**
   * 更新日志
   * @param {string} id
   * @param {Object} data
   * @returns {Promise<Object|null>}
   */
  async update(id, data) {
    return this.adapter.updateLog(id, data);
  }

  /**
   * 删除日志
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    return this.adapter.deleteLog(id);
  }

  /**
   * Upsert（存在则更新，不存在则插入）
   * @param {Object} data
   * @param {string} deviceId
   * @param {string} userId
   * @returns {Promise<Object>}
   */
  async upsert(data, deviceId, userId) {
    return this.adapter.upsertLog(data, deviceId, userId);
  }

  /**
   * 查询增量数据（用于同步）
   * @param {string} deviceId
   * @param {string} timestamp - ISO 时间戳
   * @param {string} userId
   * @returns {Promise<Array>}
   */
  async findSince(deviceId, timestamp, userId) {
    return this.adapter.findSince(deviceId, timestamp, userId);
  }
}

export class DictionaryRepository {
  constructor(adapter) {
    this.adapter = adapter;
  }

  /**
   * 查询词典
   * @param {string} type - 词典类型
   * @param {Object} query - 查询条件
   * @returns {Promise<Array>}
   */
  async findAll(type, query = {}) {
    return this.adapter.findDictionaries(type, query);
  }

  /**
   * 根据 ID 查询词典条目
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async findById(id) {
    return this.adapter.findDictionaryById(id);
  }

  /**
   * 创建词典条目
   * @param {string} type
   * @param {Object} data
   * @returns {Promise<Object>}
   */
  async create(type, data) {
    return this.adapter.createDictionary(type, data);
  }

  /**
   * 更新词典条目
   * @param {string} id
   * @param {Object} data
   * @returns {Promise<Object|null>}
   */
  async update(id, data) {
    return this.adapter.updateDictionary(id, data);
  }

  /**
   * 删除词典条目
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    return this.adapter.deleteDictionary(id);
  }

  /**
   * 批量创建词典条目
   * @param {string} type
   * @param {Array} items
   * @returns {Promise<Array>}
   */
  async bulkCreate(type, items) {
    return this.adapter.bulkCreateDictionary(type, items);
  }

  async bulkUpsert(items, userId) {
    return this.adapter.bulkUpsertDictionary(items, userId);
  }

  async findAllByUser(userId) {
    return this.adapter.findDictionariesByUser(userId);
  }
}

export class DeviceRepository {
  constructor(adapter) {
    this.adapter = adapter;
  }

  /**
   * 查询所有设备
   * @returns {Promise<Array>}
   */
  async findAll() {
    return this.adapter.findDevices();
  }

  /**
   * 更新设备信息（不存在则创建）
   * @param {string} deviceId
   * @param {string} name
   * @returns {Promise<Object>}
   */
  async upsert(deviceId, name) {
    return this.adapter.upsertDevice(deviceId, name);
  }
}

export class UserRepository {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async findById(id) {
    return this.adapter.findUserById(id);
  }

  async findByUsername(username) {
    return this.adapter.findUserByUsername(username);
  }

  async createUser(username, passwordHash, role = 'user', parentId = null, theme = 'light') {
    return this.adapter.createUser(username, passwordHash, role, parentId, theme);
  }

  async updateUser(id, data) {
    return this.adapter.updateUser(id, data);
  }

  async findUsersByParentId(parentId) {
    return this.adapter.findUsersByParentId(parentId);
  }

  async deleteUser(id) {
    return this.adapter.deleteUser(id);
  }

  async findAllUsers() {
    return this.adapter.findAllUsers();
  }
}

export class SyncRecordRepository {
  constructor(adapter) {
    this.adapter = adapter;
  }

  /**
   * 创建同步记录
   * @param {string} deviceId
   * @param {string} syncType
   * @param {number} recordsCount
   * @returns {Promise<void>}
   */
  async create(deviceId, syncType, recordsCount) {
    return this.adapter.createSyncRecord(deviceId, syncType, recordsCount);
  }

  /**
   * 获取同步记录
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async findRecent(limit = 50) {
    return this.adapter.getSyncRecords(limit);
  }
}

// Shares repository: delegates to Memory/Mongo/etc adapters
export class ShareRepository {
  constructor(adapter) {
    this.adapter = adapter;
  }

  /**
   * Find shares by fromUserId or toUserId
   * @param {Object} query
   * @returns {Promise<Array>}
   */
  async findAll(query = {}) {
    return this.adapter.findShares(query);
  }

  /**
   * Create a new share
   * @param {Object} data
   * @returns {Promise<Object>}
   */
  async create(data) {
    return this.adapter.createShare(data);
  }

  /**
   * Update a share
   * @param {string} id
   * @param {Object} data
   * @returns {Promise<Object|null>}
   */
  async update(id, data) {
    return this.adapter.updateShare(id, data);
  }

  /**
   * Delete a share
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    return this.adapter.deleteShare(id);
  }

  /**
   * Get logs shared from one user to another
   * @param {string} fromUserId
   * @param {string} toUserId
   * @returns {Promise<Array|null>}
   */
  async findSharedLogs(fromUserId, toUserId) {
    return this.adapter.findSharedLogs(fromUserId, toUserId);
  }

  /**
   * Get dictionaries shared from one user to another
   * @param {string} fromUserId
   * @param {string} toUserId
   * @returns {Promise<Array|null>}
   */
  async findSharedDictionaries(fromUserId, toUserId) {
    return this.adapter.findSharedDictionaries(fromUserId, toUserId);
  }
}

export class CallsignQthRepository {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async addRecord(callsign, qth, userId) {
    return this.adapter.addCallsignQthRecord(callsign, qth, userId);
  }

  async getHistory(callsign) {
    return this.adapter.getCallsignQthHistory(callsign);
  }

  async getAllHistory(userId) {
    return this.adapter.getAllCallsignQthHistory(userId);
  }

  async clearHistory(userId) {
    return this.adapter.clearCallsignQthHistory(userId);
  }

  async upsert(callsign, qth, userId) {
    return this.adapter.addCallsignQthRecord(callsign, qth, userId);
  }

  async findSince(timestamp, userId) {
    return this.adapter.findCallsignQthHistorySince(timestamp, userId);
  }
}
