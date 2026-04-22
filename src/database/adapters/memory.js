/**
 * @fileoverview 内存数据库适配器（用于开发和测试）
 */

import { v4 as uuidv4 } from 'uuid';

const toDate = value => {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
};

const latestDate = (...values) => {
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

  if (!incoming) return true;
  if (!existing) return true;

  return incoming.getTime() >= existing.getTime();
};

export class MemoryAdapter {
  constructor() {
    this.logs = new Map();
    this.dictionaries = new Map();
    this.devices = new Map();
    this.users = new Map();
    this.syncRecords = [];
    this.shares = new Map();
    this.callsignQthHistory = [];
    this.histories = new Map();
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
    this.shares.clear();
    this.callsignQthHistory = [];
    this.histories.clear();
  }

  // 日志操作
  async findLogs(query = {}, pagination = { page: 1, pageSize: 20 }) {
    const { page, pageSize } = pagination;
    let data = Array.from(this.logs.values());

    if (!query.includeDeleted) {
      data = data.filter(l => !l.deletedAt);
    }

    if (query.userId) {
      data = data.filter(l => l.userId === query.userId);
    }
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
    const now = latestDate(data.updatedAt, data.createdAt) || new Date();
    const id = data.id || uuidv4();
    const sourceDeviceId = data.sourceDeviceId ?? data.deviceId ?? null;
    const log = {
      id,
      syncId: data.syncId ?? id,
      deviceId: sourceDeviceId,
      sourceDeviceId,
      userId: data.userId,
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
      clientUpdatedAt: toDate(data.clientUpdatedAt),
      serverUpdatedAt: new Date(),
      createdAt: toDate(data.createdAt) || now,
      updatedAt: toDate(data.updatedAt) || now,
      deletedAt: toDate(data.deletedAt),
    };
    this.logs.set(id, log);
    return log;
  }

  async updateLog(id, data) {
    const existing = this.logs.get(id);
    if (!existing) return null;

    const updatedAt = toDate(data.updatedAt) || new Date();
    const updated = {
      ...existing,
      syncId: data.syncId ?? existing.syncId,
      deviceId: data.sourceDeviceId ?? data.deviceId ?? existing.deviceId,
      sourceDeviceId: data.sourceDeviceId ?? data.deviceId ?? existing.sourceDeviceId,
      userId: data.userId ?? existing.userId,
      localId: data.localId ?? existing.localId,
      time: data.time ?? existing.time,
      controller: data.controller ?? existing.controller,
      callsign: data.callsign ?? existing.callsign,
      report: data.report ?? existing.report,
      qth: data.qth ?? existing.qth,
      device: data.device ?? existing.device,
      power: data.power ?? existing.power,
      antenna: data.antenna ?? existing.antenna,
      height: data.height ?? existing.height,
      clientUpdatedAt: toDate(data.clientUpdatedAt) ?? existing.clientUpdatedAt,
      serverUpdatedAt: new Date(),
      createdAt: toDate(data.createdAt) || existing.createdAt,
      updatedAt,
      deletedAt: data.deletedAt !== undefined ? toDate(data.deletedAt) : existing.deletedAt,
    };
    this.logs.set(id, updated);
    return updated;
  }

  async deleteLog(id) {
    return this.logs.delete(id);
  }

  async upsertLog(data, deviceId, userId) {
    return this.upsertLogSync(data, deviceId, userId);
  }

  async upsertLogSync(data, deviceId, userId) {
    let existing = null;
    if (data.id) {
      existing = this.logs.get(data.id) || null;
    }
    if (!existing && data.localId) {
      existing = Array.from(this.logs.values()).find(
        l => l.localId === data.localId && l.deviceId === (data.sourceDeviceId ?? deviceId)
      );
    }
    if (existing) {
      const incomingUpdatedAt = latestDate(data.updatedAt, data.deletedAt, data.createdAt);
      const existingUpdatedAt = latestDate(existing.updatedAt, existing.deletedAt, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }
      return this.updateLog(existing.id, data);
    }
    return this.createLog({ ...data, deviceId, userId, sourceDeviceId: data.sourceDeviceId ?? deviceId });
  }

  async findSince(deviceId, timestamp, userId) {
    const ts = new Date(timestamp);
    return Array.from(this.logs.values())
      .filter(l => l.deviceId === deviceId && l.userId === userId && new Date(l.updatedAt) > ts)
      .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  }

  async findLogsSince(timestamp, userId) {
    const ts = new Date(timestamp);
    return Array.from(this.logs.values())
      .filter(log => log.userId === userId)
      .filter(log => {
        const changedAt = latestDate(log.updatedAt, log.deletedAt, log.createdAt);
        return changedAt && changedAt > ts;
      })
      .sort((a, b) => latestDate(a.updatedAt, a.deletedAt, a.createdAt) - latestDate(b.updatedAt, b.deletedAt, b.createdAt));
  }

  async softDeleteLog(id, deletedAt, userId) {
    const existing = this.logs.get(id);
    if (!existing || (userId && existing.userId !== userId)) {
      return null;
    }

    const deletionTime = toDate(deletedAt) || new Date();
    const updated = {
      ...existing,
      deletedAt: deletionTime,
      updatedAt: deletionTime,
    };

    this.logs.set(id, updated);
    return updated;
  }

  // 词典操作
  async findDictionaries(type, query = {}) {
    let data = Array.from(this.dictionaries.values());

    if (!query.includeDeleted) {
      data = data.filter(d => !d.deletedAt);
    }

    if (query.userId) {
      data = data.filter(d => d.userId === query.userId);
    }
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
    const now = latestDate(data.updatedAt, data.createdAt) || new Date();
    const id = data.id || uuidv4();
    const dict = {
      id,
      syncId: data.syncId ?? id,
      userId: data.userId,
      sourceDeviceId: data.sourceDeviceId ?? null,
      type,
      raw: data.raw,
      pinyin: data.pinyin,
      abbreviation: data.abbreviation,
      clientUpdatedAt: toDate(data.clientUpdatedAt),
      serverUpdatedAt: new Date(),
      createdAt: toDate(data.createdAt) || now,
      updatedAt: toDate(data.updatedAt) || now,
      deletedAt: toDate(data.deletedAt),
    };
    this.dictionaries.set(id, dict);
    return dict;
  }

  async updateDictionary(id, data) {
    const existing = this.dictionaries.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      syncId: data.syncId ?? existing.syncId,
      userId: data.userId ?? existing.userId,
      sourceDeviceId: data.sourceDeviceId ?? existing.sourceDeviceId,
      type: data.type ?? existing.type,
      raw: data.raw ?? existing.raw,
      pinyin: data.pinyin ?? existing.pinyin,
      abbreviation: data.abbreviation ?? existing.abbreviation,
      clientUpdatedAt: toDate(data.clientUpdatedAt) ?? existing.clientUpdatedAt,
      serverUpdatedAt: new Date(),
      createdAt: toDate(data.createdAt) || existing.createdAt,
      updatedAt: toDate(data.updatedAt) || new Date(),
      deletedAt: data.deletedAt !== undefined ? toDate(data.deletedAt) : existing.deletedAt,
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

  async bulkUpsertDictionary(items, userId) {
    for (const item of items) {
      await this.upsertDictionarySync(item, userId);
    }
  }

  async findDictionariesByUser(userId) {
    return Array.from(this.dictionaries.values()).filter(
      d => d.userId === userId && !d.deletedAt
    ).sort((a, b) => a.raw.localeCompare(b.raw));
  }

  async findDictionariesSince(timestamp, userId) {
    const ts = new Date(timestamp);
    return Array.from(this.dictionaries.values())
      .filter(item => item.userId === userId)
      .filter(item => {
        const changedAt = latestDate(item.updatedAt, item.deletedAt, item.createdAt);
        return changedAt && changedAt > ts;
      })
      .sort((a, b) => latestDate(a.updatedAt, a.deletedAt, a.createdAt) - latestDate(b.updatedAt, b.deletedAt, b.createdAt));
  }

  async upsertDictionarySync(item, userId) {
    const existing = item.id
      ? this.dictionaries.get(item.id)
      : Array.from(this.dictionaries.values()).find(
        entry => entry.userId === userId && entry.type === item.type && entry.raw === item.raw
      );

    if (existing) {
      const incomingUpdatedAt = latestDate(item.updatedAt, item.deletedAt, item.createdAt);
      const existingUpdatedAt = latestDate(existing.updatedAt, existing.deletedAt, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }

      return this.updateDictionary(existing.id, { ...item, userId, type: item.type ?? existing.type });
    }

    return this.createDictionary(item.type, { ...item, userId });
  }

  async softDeleteDictionary(id, deletedAt, userId) {
    const existing = this.dictionaries.get(id);
    if (!existing || (userId && existing.userId !== userId)) {
      return null;
    }

    const deletionTime = toDate(deletedAt) || new Date();
    const updated = {
      ...existing,
      deletedAt: deletionTime,
      updatedAt: deletionTime,
    };

    this.dictionaries.set(id, updated);
    return updated;
  }

  async addCallsignQthRecord(callsign, qth, userId) {
    const existing = this.callsignQthHistory.find(
      h => h.callsign === callsign.toUpperCase() && h.qth === qth && h.userId === userId && !h.deletedAt
    );
    const now = new Date();
    if (existing) {
      existing.timestamp = now;
      existing.recordedAt = now;
      existing.updatedAt = now;
      return existing;
    }
    const record = {
      id: uuidv4(),
      syncId: existing?.syncId ?? uuidv4(),
      userId,
      callsign: callsign.toUpperCase(),
      qth,
      sourceDeviceId: null,
      timestamp: now,
      recordedAt: now,
      clientUpdatedAt: null,
      serverUpdatedAt: new Date(),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.callsignQthHistory.push(record);
    return record;
  }

  async getCallsignQthHistory(callsign, userId) {
    if (!callsign) return [];
    return this.callsignQthHistory
      .filter(h => h.callsign === callsign.toUpperCase() && h.userId === userId && !h.deletedAt)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  async getAllCallsignQthHistory(userId) {
    return this.callsignQthHistory
      .filter(h => h.userId === userId && !h.deletedAt)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  async clearCallsignQthHistory(userId) {
    this.callsignQthHistory = this.callsignQthHistory.filter(h => h.userId !== userId);
  }

  async findCallsignQthHistorySince(timestamp, userId) {
    return this.callsignQthHistory
      .filter(h => h.userId === userId)
      .filter(h => {
        const changedAt = latestDate(h.updatedAt, h.deletedAt, h.recordedAt, h.timestamp, h.createdAt);
        return changedAt && changedAt > new Date(timestamp);
      })
      .sort((a, b) => latestDate(a.updatedAt, a.deletedAt, a.recordedAt, a.timestamp, a.createdAt) - latestDate(b.updatedAt, b.deletedAt, b.recordedAt, b.timestamp, b.createdAt));
  }

  async upsertCallsignQthSync(record, userId) {
    const normalized = {
      ...record,
      userId,
      callsign: record.callsign?.toUpperCase(),
    };
    const existingIndex = this.callsignQthHistory.findIndex(item => item.id === normalized.id);
    const existing = existingIndex >= 0
      ? this.callsignQthHistory[existingIndex]
      : this.callsignQthHistory.find(item => item.userId === userId && item.callsign === normalized.callsign && item.qth === normalized.qth);

    if (existing) {
      const incomingUpdatedAt = latestDate(normalized.updatedAt, normalized.deletedAt, normalized.recordedAt, normalized.timestamp, normalized.createdAt);
      const existingUpdatedAt = latestDate(existing.updatedAt, existing.deletedAt, existing.recordedAt, existing.timestamp, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }

      const updated = {
        ...existing,
        ...normalized,
        syncId: normalized.syncId ?? existing.syncId,
        sourceDeviceId: normalized.sourceDeviceId ?? existing.sourceDeviceId,
        recordedAt: toDate(normalized.recordedAt) || toDate(normalized.timestamp) || existing.recordedAt,
        timestamp: toDate(normalized.timestamp) || toDate(normalized.recordedAt) || existing.timestamp,
        clientUpdatedAt: toDate(normalized.clientUpdatedAt) ?? existing.clientUpdatedAt,
        serverUpdatedAt: new Date(),
        createdAt: toDate(normalized.createdAt) || existing.createdAt,
        updatedAt: toDate(normalized.updatedAt) || new Date(),
        deletedAt: normalized.deletedAt !== undefined ? toDate(normalized.deletedAt) : existing.deletedAt,
      };

      if (existingIndex >= 0) {
        this.callsignQthHistory[existingIndex] = updated;
      } else {
        const index = this.callsignQthHistory.findIndex(item => item.id === existing.id);
        this.callsignQthHistory[index] = updated;
      }

      return updated;
    }

    const id = normalized.id || uuidv4();
    const created = {
      id,
      syncId: normalized.syncId ?? id,
      userId,
      callsign: normalized.callsign,
      qth: normalized.qth,
      sourceDeviceId: normalized.sourceDeviceId ?? null,
      recordedAt: toDate(normalized.recordedAt) || toDate(normalized.timestamp) || new Date(),
      timestamp: toDate(normalized.timestamp) || toDate(normalized.recordedAt) || new Date(),
      clientUpdatedAt: toDate(normalized.clientUpdatedAt),
      serverUpdatedAt: new Date(),
      createdAt: toDate(normalized.createdAt) || new Date(),
      updatedAt: toDate(normalized.updatedAt) || new Date(),
      deletedAt: toDate(normalized.deletedAt),
    };

    this.callsignQthHistory.push(created);
    return created;
  }

  async softDeleteCallsignQth(id, deletedAt, userId) {
    const index = this.callsignQthHistory.findIndex(record => record.id === id && (!userId || record.userId === userId));
    if (index < 0) {
      return null;
    }

    const deletionTime = toDate(deletedAt) || new Date();
    const updated = {
      ...this.callsignQthHistory[index],
      deletedAt: deletionTime,
      updatedAt: deletionTime,
    };
    this.callsignQthHistory[index] = updated;
    return updated;
  }

  async findHistories(query = {}) {
    let data = Array.from(this.histories.values());

    if (query.userId) {
      data = data.filter(item => item.userId === query.userId);
    }

    if (!query.includeDeleted) {
      data = data.filter(item => !item.deletedAt);
    }

    return data.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async findHistoryById(id) {
    return this.histories.get(id) || null;
  }

  async createHistory(data) {
    const now = latestDate(data.updatedAt, data.createdAt) || new Date();
    const id = data.id || uuidv4();
    const history = {
      id,
      syncId: data.syncId ?? id,
      userId: data.userId,
      sourceDeviceId: data.sourceDeviceId ?? null,
      name: data.name,
      logsData: data.logsData,
      logCount: data.logCount ?? 0,
      clientUpdatedAt: toDate(data.clientUpdatedAt),
      serverUpdatedAt: new Date(),
      createdAt: toDate(data.createdAt) || now,
      updatedAt: toDate(data.updatedAt) || now,
      deletedAt: toDate(data.deletedAt),
    };

    this.histories.set(history.id, history);
    return history;
  }

  async updateHistory(id, data) {
    const existing = this.histories.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      syncId: data.syncId ?? existing.syncId,
      userId: data.userId ?? existing.userId,
      sourceDeviceId: data.sourceDeviceId ?? existing.sourceDeviceId,
      name: data.name ?? existing.name,
      logsData: data.logsData ?? existing.logsData,
      logCount: data.logCount ?? existing.logCount,
      clientUpdatedAt: toDate(data.clientUpdatedAt) ?? existing.clientUpdatedAt,
      serverUpdatedAt: new Date(),
      createdAt: toDate(data.createdAt) || existing.createdAt,
      updatedAt: toDate(data.updatedAt) || new Date(),
      deletedAt: data.deletedAt !== undefined ? toDate(data.deletedAt) : existing.deletedAt,
    };

    this.histories.set(id, updated);
    return updated;
  }

  async deleteHistory(id) {
    return this.histories.delete(id);
  }

  async findHistoriesSince(timestamp, userId) {
    const ts = new Date(timestamp);
    return Array.from(this.histories.values())
      .filter(item => item.userId === userId)
      .filter(item => {
        const changedAt = latestDate(item.updatedAt, item.deletedAt, item.createdAt);
        return changedAt && changedAt > ts;
      })
      .sort((a, b) => latestDate(a.updatedAt, a.deletedAt, a.createdAt) - latestDate(b.updatedAt, b.deletedAt, b.createdAt));
  }

  async upsertHistorySync(data, userId) {
    const existing = data.id ? this.histories.get(data.id) : null;

    if (existing) {
      const incomingUpdatedAt = latestDate(data.updatedAt, data.deletedAt, data.createdAt);
      const existingUpdatedAt = latestDate(existing.updatedAt, existing.deletedAt, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }

      return this.updateHistory(existing.id, { ...data, userId });
    }

    return this.createHistory({ ...data, userId });
  }

  async softDeleteHistory(id, deletedAt, userId) {
    const existing = this.histories.get(id);
    if (!existing || (userId && existing.userId !== userId)) {
      return null;
    }

    const deletionTime = toDate(deletedAt) || new Date();
    const updated = {
      ...existing,
      deletedAt: deletionTime,
      updatedAt: deletionTime,
    };

    this.histories.set(id, updated);
    return updated;
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
  async createSyncRecord(deviceId, syncType, recordsCount, details = null) {
    this.syncRecords.push({
      id: uuidv4(),
      deviceId,
      syncType,
      recordsCount,
      details,
      syncedAt: new Date(),
    });
  }

  async getSyncRecords(limit = 50) {
    return this.syncRecords
      .sort((a, b) => new Date(b.syncedAt) - new Date(a.syncedAt))
      .slice(0, limit);
  }

  // Sharing-related APIs
  async findShares(query = {}) {
    const results = Array.from(this.shares.values());
    return results.filter(s => {
      const fromMatch = query.fromUserId ? s.fromUserId === query.fromUserId : true;
      const toMatch = query.toUserId ? s.toUserId === query.toUserId : true;
      return fromMatch && toMatch;
    });
  }

  async createShare(data) {
    const id = uuidv4();
    const share = {
      id,
      fromUserId: data.fromUserId,
      toUserId: data.toUserId,
      shareType: data.shareType,
      status: data.status || 'active',
      itemIds: Array.isArray(data.itemIds) ? data.itemIds : data.itemIds == null ? null : [],
      autoSync: data.autoSync ?? false,
      createdAt: new Date(),
    };
    this.shares.set(id, share);
    return share;
  }

  async updateShare(id, data) {
    const existing = this.shares.get(id);
    if (!existing) return null;
    const updated = {
      ...existing,
      shareType: data.shareType ?? existing.shareType,
      itemIds: Array.isArray(data.itemIds) ? data.itemIds : existing.itemIds,
      status: data.status ?? existing.status,
      autoSync: data.autoSync ?? existing.autoSync,
    };
    this.shares.set(id, updated);
    return updated;
  }

  async deleteShare(id) {
    return this.shares.delete(id);
  }

  async findSharedLogs(fromUserId, toUserId) {
    const shares = Array.from(this.shares.values()).filter(s =>
      s.fromUserId === fromUserId && s.toUserId === toUserId && (s.shareType === 'logs' || s.shareType === 'both')
    );
    // flatten itemIds
    const logs = [];
    for (const s of shares) {
      if (Array.isArray(s.itemIds)) logs.push(...s.itemIds);
      // if itemIds is null, we treat as all-logs; return null to indicate all
      if (s.itemIds == null) return null;
    }
    return logs;
  }

  async findSharedDictionaries(fromUserId, toUserId) {
    const shares = Array.from(this.shares.values()).filter(s =>
      s.fromUserId === fromUserId && s.toUserId === toUserId && (s.shareType === 'dictionaries' || s.shareType === 'both')
    );
    const dicts = [];
    for (const s of shares) {
      if (Array.isArray(s.itemIds)) dicts.push(...s.itemIds);
      if (s.itemIds == null) return null;
    }
    return dicts;
  }
}
