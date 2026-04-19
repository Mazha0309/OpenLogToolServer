import { LogRepository, DictionaryRepository, DeviceRepository, UserRepository, SyncRecordRepository, ShareRepository, CallsignQthRepository } from '../database/index.js';
import connector from '../database/connector.js';

export class SyncService {
  constructor() {
    this.logRepo = null;
    this.dictRepo = null;
    this.deviceRepo = null;
    this.syncRecordRepo = null;
    this.callsignQthRepo = null;
  }

  async init() {
    const adapter = await connector.connect();
    this.logRepo = new LogRepository(adapter);
    this.dictRepo = new DictionaryRepository(adapter);
    this.deviceRepo = new DeviceRepository(adapter);
    this.syncRecordRepo = new SyncRecordRepository(adapter);
    this.callsignQthRepo = new CallsignQthRepository(adapter);
  }

  async pushSync(logs, deviceId, userId, dictionaries, callsignQthHistory) {
    const mapping = {};
    for (const log of logs) {
      const result = await this.logRepo.upsert(log, deviceId, userId);
      mapping[log.localId || log.id] = result.id;
    }
    if (dictionaries && dictionaries.length > 0) {
      await this.dictRepo.bulkUpsert(dictionaries, userId);
    }
    if (callsignQthHistory && callsignQthHistory.length > 0) {
      for (const record of callsignQthHistory) {
        await this.callsignQthRepo.upsert(record.callsign, record.qth, userId);
      }
    }
    await this.deviceRepo.upsert(deviceId, deviceId);
    if (this.syncRecordRepo) {
      await this.syncRecordRepo.create(deviceId, 'push', logs.length);
    }
    return { success: true, mapping, lastSync: new Date().toISOString() };
  }

  async pullSync(deviceId, since, userId) {
    const logs = await this.logRepo.findSince(deviceId, since, userId);
    const dictionaries = await this.dictRepo.findAllByUser(userId);
    const callsignQthHistory = await this.callsignQthRepo.findSince(since, userId);
    return { success: true, logs, dictionaries, callsignQthHistory, lastSync: new Date().toISOString() };
  }

  async bidirectionalSync(localLogs, deviceId, userId, dictionaries, callsignQthHistory) {
    const strategy = process.env.SYNC_STRATEGY || 'server-wins';
    const serverLogs = await this.logRepo.findSince(deviceId, '1970-01-01T00:00:00.000Z', userId);
    const serverLogMap = new Map(serverLogs.map(l => [l.localId || l.id, l]));

    const mergedLogs = [...serverLogs];
    const mapping = {};

    for (const localLog of localLogs) {
      const serverLog = serverLogMap.get(localLog.localId || localLog.id);
      if (!serverLog) {
        const result = await this.logRepo.upsert(localLog, deviceId, userId);
        mapping[localLog.localId || localLog.id] = result.id;
        mergedLogs.push(localLog);
      } else if (strategy === 'client-wins') {
        const serverTime = new Date(serverLog.updatedAt).getTime();
        const localTime = new Date(localLog.updatedAt || localLog.createdAt).getTime();
        if (localTime > serverTime) {
          const result = await this.logRepo.upsert(localLog, deviceId, userId);
          mapping[localLog.localId || localLog.id] = result.id;
        }
      }
    }

    if (dictionaries && dictionaries.length > 0) {
      await this.dictRepo.bulkUpsert(dictionaries, userId);
    }

    if (callsignQthHistory && callsignQthHistory.length > 0) {
      for (const record of callsignQthHistory) {
        await this.callsignQthRepo.upsert(record.callsign, record.qth, userId);
      }
    }

    await this.deviceRepo.upsert(deviceId, deviceId);
    if (this.syncRecordRepo) {
      await this.syncRecordRepo.create(deviceId, 'bidirectional', localLogs.length);
    }

    return { success: true, logs: mergedLogs, dictionaries: serverLogs, mapping, lastSync: new Date().toISOString() };
  }
}

export class LogService {
  constructor() {
    this.repo = null;
  }

  async init() {
    const adapter = await connector.connect();
    this.repo = new LogRepository(adapter);
  }

  async listLogs(query, pagination) {
    return this.repo.findAll(query, pagination);
  }

  async getLog(id) {
    return this.repo.findById(id);
  }

  async createLog(data) {
    return this.repo.create(data);
  }

  async updateLog(id, data) {
    return this.repo.update(id, data);
  }

  async deleteLog(id) {
    return this.repo.delete(id);
  }
}

export class DictionaryService {
  constructor() {
    this.repo = null;
  }

  async init() {
    const adapter = await connector.connect();
    this.repo = new DictionaryRepository(adapter);
  }

  async listDictionaries(type, query) {
    return this.repo.findAll(type, query);
  }

  async createDictionary(type, data) {
    return this.repo.create(type, data);
  }

  async updateDictionary(id, data) {
    return this.repo.update(id, data);
  }

  async deleteDictionary(id) {
    return this.repo.delete(id);
  }

  async bulkCreate(type, items) {
    return this.repo.bulkCreate(type, items);
  }
}

export class ShareService {
  constructor() {
    this.repo = null;
  }

  async init() {
    const adapter = await connector.connect();
    this.repo = new ShareRepository(adapter);
  }

  async listShares(query) {
    return this.repo.findAll(query);
  }

  async createShare(data) {
    return this.repo.create(data);
  }

  async updateShare(id, data) {
    return this.repo.update(id, data);
  }

  async deleteShare(id) {
    return this.repo.delete(id);
  }

  async getSharesByUser(userId) {
    const sent = await this.repo.findByFromUser(userId);
    const received = await this.repo.findByToUser(userId);
    return { sent, received };
  }

  async updateShareConfig(fromUserId, shareType, itemIds, toUserIds, autoSync) {
    const existingShares = await this.repo.findByFromUser(fromUserId);

    for (const share of existingShares) {
      await this.repo.delete(share.id);
    }

    const itemIdsObj = typeof itemIds === 'object' && !Array.isArray(itemIds) ? itemIds : { logs: itemIds };
    const autoSyncObj = typeof autoSync === 'object' ? autoSync : { logs: autoSync };

    const types = ['logs', 'dictionaries', 'history'];
    for (const type of types) {
      const ids = itemIdsObj[type] || [];
      const sync = autoSyncObj[type] || false;

      for (const toUserId of toUserIds) {
        if (ids.length === 0 && !sync) continue;
        await this.repo.create({
          fromUserId,
          toUserId,
          shareType: type,
          itemIds: ids,
          autoSync: sync,
          status: 'active',
        });
      }
    }
  }

  async findSharedLogs(fromUserId, toUserId, itemIds) {
    return this.repo.findSharedLogs(fromUserId, toUserId, itemIds);
  }

  async findSharedDictionaries(fromUserId, toUserId) {
    return this.repo.findSharedDictionaries(fromUserId, toUserId);
  }

  async listLogsSharedTo(toUserId, itemIds) {
    const shares = await this.repo.findAll({ toUserId });
    const allNull = shares.some(s => (s.shareType === 'logs' || s.shareType === 'both') && s.itemIds == null);
    if (allNull) return null;
    const logs = [];
    for (const s of shares) {
      if (s.shareType === 'logs' || s.shareType === 'both') {
        if (Array.isArray(s.itemIds)) {
          if (itemIds) {
            logs.push(...s.itemIds.filter(id => itemIds.includes(id)));
          } else {
            logs.push(...s.itemIds);
          }
        }
      }
      if (logs.length > 0 && s.itemIds == null) return null;
    }
    return logs;
  }

  async listDictionariesSharedTo(toUserId, itemIds) {
    const shares = await this.repo.findAll({ toUserId });
    const allNull = shares.some(s => (s.shareType === 'dictionaries' || s.shareType === 'both') && s.itemIds == null);
    if (allNull) return null;
    const dicts = [];
    for (const s of shares) {
      if (s.shareType === 'dictionaries' || s.shareType === 'both') {
        if (Array.isArray(s.itemIds)) {
          if (itemIds) {
            dicts.push(...s.itemIds.filter(id => itemIds.includes(id)));
          } else {
            dicts.push(...s.itemIds);
          }
        }
      }
      if (dicts.length > 0 && s.itemIds == null) return null;
    }
    return dicts;
  }
}

export class DeviceService {
  constructor() {
    this.repo = null;
  }

  async init() {
    const adapter = await connector.connect();
    this.repo = new DeviceRepository(adapter);
  }

  async listDevices() {
    return this.repo.findAll();
  }

  async upsertDevice(deviceId, name) {
    return this.repo.upsert(deviceId, name);
  }
}

export class AuthService {
  constructor() {
    this.userRepo = null;
  }

  async init() {
    const adapter = await connector.connect();
    this.userRepo = new UserRepository(adapter);
  }

  async validateUser(username, password) {
    const bcrypt = (await import('bcryptjs')).default;
    const user = await this.userRepo.findByUsername(username);
    if (!user) return null;
    const isValid = await bcrypt.compare(password, user.passwordHash);
    return isValid ? user : null;
  }

  async createUser(username, password, role = 'user', parentId = null) {
    const bcrypt = (await import('bcryptjs')).default;
    const passwordHash = bcrypt.hashSync(password, 10);
    return this.userRepo.createUser(username, passwordHash, role, parentId);
  }

  async getUserById(id) {
    return this.userRepo.findById(id);
  }

  async getUserByUsername(username) {
    return this.userRepo.findByUsername(username);
  }

  async changePassword(userId, oldPassword, newPassword) {
    const bcrypt = (await import('bcryptjs')).default;
    const user = await this.userRepo.findById(userId);
    if (!user) return false;

    const isValid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isValid) return false;

    const newHash = bcrypt.hashSync(newPassword, 10);
    await this.userRepo.updateUser(userId, { passwordHash: newHash });
    return true;
  }

  async updateUserTheme(userId, theme) {
    return this.userRepo.updateUser(userId, { theme });
  }

  async updateUsername(userId, newUsername) {
    return this.userRepo.updateUser(userId, { username: newUsername });
  }

  async getSubAccounts(parentId) {
    return this.userRepo.findUsersByParentId(parentId);
  }

  async deleteUser(userId) {
    return this.userRepo.deleteUser(userId);
  }

  async getAllUsers() {
    return this.userRepo.findAllUsers();
  }
}
