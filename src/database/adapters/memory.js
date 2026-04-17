/**
 * @fileoverview 内存数据库适配器（用于开发和测试）
 */

import { v4 as uuidv4 } from 'uuid';

export class MemoryAdapter {
  constructor() {
    this.logs = new Map();
    this.dictionaries = new Map();
    this.devices = new Map();
    this.users = new Map();
    this.syncRecords = [];
  }

  async connect() {
    const bcrypt = (await import('bcryptjs')).default;
    const hash = bcrypt.hashSync('admin123', 10);
    await this.createUser('admin', hash, 'admin');
    return this;
  }

  async disconnect() {
    this.logs.clear();
    this.dictionaries.clear();
    this.devices.clear();
    this.users.clear();
    this.syncRecords = [];
  }

  // 日志操作
  async findLogs(query = {}, pagination = { page: 1, pageSize: 20 }) {
    const { page, pageSize } = pagination;
    let data = Array.from(this.logs.values());

    if (query.callsign) {
      data = data.filter(l => l.callsign.includes(query.callsign));
    }
    if (query.controller) {
      data = data.filter(l => l.controller.includes(query.controller));
    }
    if (query.deviceId) {
      data = data.filter(l => l.deviceId === query.deviceId);
    }

    data.sort((a, b) => new Date(b.time) - new Date(a.time));

    const total = data.length;
    const start = (page - 1) * pageSize;
    return {
      data: data.slice(start, start + pageSize),
      total,
      page,
      pageSize,
    };
  }

  async findLogById(id) {
    return this.logs.get(id) || null;
  }

  async createLog(data) {
    const id = uuidv4();
    const log = {
      id,
      deviceId: data.deviceId,
      localId: data.localId,
      time: data.time,
      controller: data.controller,
      callsign: data.callsign,
      report: data.report,
      qth: data.qth,
      device: data.device,
      power: data.power,
      antenna: data.antenna,
      height: data.height,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.logs.set(id, log);
    return log;
  }

  async updateLog(id, data) {
    const existing = this.logs.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      time: data.time ?? existing.time,
      controller: data.controller ?? existing.controller,
      callsign: data.callsign ?? existing.callsign,
      report: data.report ?? existing.report,
      qth: data.qth ?? existing.qth,
      device: data.device ?? existing.device,
      power: data.power ?? existing.power,
      antenna: data.antenna ?? existing.antenna,
      height: data.height ?? existing.height,
      updatedAt: new Date(),
    };
    this.logs.set(id, updated);
    return updated;
  }

  async deleteLog(id) {
    return this.logs.delete(id);
  }

  async upsertLog(data, deviceId) {
    // 优先通过 localId 查找
    let existing = null;
    if (data.localId) {
      existing = Array.from(this.logs.values()).find(
        l => l.localId === data.localId && l.deviceId === deviceId
      );
    }
    if (existing) {
      return this.updateLog(existing.id, data);
    }
    return this.createLog({ ...data, deviceId });
  }

  async findSince(deviceId, timestamp) {
    const ts = new Date(timestamp);
    return Array.from(this.logs.values()).filter(
      l => l.deviceId === deviceId && new Date(l.updatedAt) > ts
    ).sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  }

  // 词典操作
  async findDictionaries(type, query = {}) {
    let data = Array.from(this.dictionaries.values());

    if (type) {
      data = data.filter(d => d.type === type);
    }
    if (query.search) {
      const s = query.search.toLowerCase();
      data = data.filter(d =>
        d.raw.toLowerCase().includes(s) ||
        (d.pinyin && d.pinyin.toLowerCase().includes(s)) ||
        (d.abbreviation && d.abbreviation.toLowerCase().includes(s))
      );
    }

    return data.sort((a, b) => a.raw.localeCompare(b.raw));
  }

  async findDictionaryById(id) {
    return this.dictionaries.get(id) || null;
  }

  async createDictionary(type, data) {
    const id = uuidv4();
    const dict = {
      id,
      type,
      raw: data.raw,
      pinyin: data.pinyin,
      abbreviation: data.abbreviation,
      createdAt: new Date(),
    };
    this.dictionaries.set(id, dict);
    return dict;
  }

  async updateDictionary(id, data) {
    const existing = this.dictionaries.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      raw: data.raw ?? existing.raw,
      pinyin: data.pinyin ?? existing.pinyin,
      abbreviation: data.abbreviation ?? existing.abbreviation,
    };
    this.dictionaries.set(id, updated);
    return updated;
  }

  async deleteDictionary(id) {
    return this.dictionaries.delete(id);
  }

  async bulkCreateDictionary(type, items) {
    for (const item of items) {
      await this.createDictionary(type, item);
    }
    return this.findDictionaries(type);
  }

  // 设备操作
  async findDevices() {
    return Array.from(this.devices.values()).sort(
      (a, b) => new Date(b.lastSyncAt || 0) - new Date(a.lastSyncAt || 0)
    );
  }

  async upsertDevice(deviceId, name) {
    const existing = Array.from(this.devices.values()).find(d => d.deviceId === deviceId);
    if (existing) {
      existing.lastSyncAt = new Date();
      if (name) existing.name = name;
      return existing;
    }

    const device = {
      id: uuidv4(),
      deviceId,
      name: name || deviceId,
      lastSyncAt: new Date(),
      createdAt: new Date(),
    };
    this.devices.set(device.id, device);
    return device;
  }

  // 用户操作
  async findUserByUsername(username) {
    return Array.from(this.users.values()).find(u => u.username === username) || null;
  }

  async findUserById(id) {
    return this.users.get(id) || null;
  }

  async createUser(username, passwordHash, role = 'user', parentId = null, theme = 'light') {
    const id = uuidv4();
    const user = {
      id,
      username,
      passwordHash,
      role,
      parentId,
      theme,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.set(id, user);
    return user;
  }

  async updateUser(id, data) {
    const user = this.users.get(id);
    if (!user) return null;
    Object.assign(user, data, { updatedAt: new Date() });
    return user;
  }

  async findUsersByParentId(parentId) {
    return Array.from(this.users.values()).filter(u => u.parentId === parentId);
  }

  async deleteUser(id) {
    return this.users.delete(id);
  }

  async findAllUsers() {
    return Array.from(this.users.values());
  }

  // 统计操作
  async getStats() {
    const now = new Date();
    const today = new Date(now.setHours(0, 0, 0, 0));
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const logs = Array.from(this.logs.values());
    const todayLogs = logs.filter(l => new Date(l.createdAt) >= today).length;
    const weekLogs = logs.filter(l => new Date(l.createdAt) >= weekAgo).length;

    return {
      totalLogs: logs.length,
      totalDictionaries: this.dictionaries.size,
      totalDevices: this.devices.size,
      todayLogs,
      weekLogs,
    };
  }

  // 同步记录
  async createSyncRecord(deviceId, syncType, recordsCount) {
    this.syncRecords.push({
      id: uuidv4(),
      deviceId,
      syncType,
      recordsCount,
      syncedAt: new Date(),
    });
  }

  async getSyncRecords(limit = 50) {
    return this.syncRecords
      .sort((a, b) => new Date(b.syncedAt) - new Date(a.syncedAt))
      .slice(0, limit);
  }
}
