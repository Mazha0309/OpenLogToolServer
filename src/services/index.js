import { LogRepository, DictionaryRepository, DeviceRepository, UserRepository, SyncRecordRepository, ShareRepository } from '../database/index.js';
import connector from '../database/connector.js';

export class SyncService {
  constructor() {
    this.logRepo = null;
    this.dictRepo = null;
    this.deviceRepo = null;
    this.syncRecordRepo = null;
  }

  async init() {
    const adapter = await connector.connect();
    this.logRepo = new LogRepository(adapter);
    this.dictRepo = new DictionaryRepository(adapter);
    this.deviceRepo = new DeviceRepository(adapter);
    this.syncRecordRepo = new SyncRecordRepository(adapter);
  }

  async pushSync(logs, deviceId, userId, dictionaries) {
    const mapping = {};
    for (const log of logs) {
      const result = await this.logRepo.upsert(log, deviceId, userId);
      mapping[log.localId || log.id] = result.id;
    }
    if (dictionaries && dictionaries.length > 0) {
      await this.dictRepo.bulkUpsert(dictionaries, userId);
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
    return { success: true, logs, dictionaries, lastSync: new Date().toISOString() };
  }

  async bidirectionalSync(localLogs, deviceId, userId, dictionaries) {
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

  async findSharedLogs(fromUserId, toUserId) {
    return this.repo.findSharedLogs(fromUserId, toUserId);
  }

  async findSharedDictionaries(fromUserId, toUserId) {
    return this.repo.findSharedDictionaries(fromUserId, toUserId);
  }

  // Helper: get logs shared with a given recipient (toUserId) regardless of sender
  async listLogsSharedTo(toUserId) {
    const shares = await this.repo.findAll({ toUserId });
    const allNull = shares.some(s => s.shareType === 'logs' || s.shareType === 'both') && s.itemIds == null;
    if (allNull) return null;
    const logs = [];
    for (const s of shares) {
      if (s.shareType === 'logs' || s.shareType === 'both') {
        if (Array.isArray(s.itemIds)) logs.push(...s.itemIds);
      }
      if (logs.length > 0 && s.itemIds == null) return null;
    }
    return logs;
  }

  // Helper: get dictionaries shared with a given recipient (toUserId)
  async listDictionariesSharedTo(toUserId) {
    const shares = await this.repo.findAll({ toUserId });
    const dicts = [];
    for (const s of shares) {
      if (s.shareType === 'dictionaries' || s.shareType === 'both') {
        if (Array.isArray(s.itemIds)) dicts.push(...s.itemIds);
      }
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
