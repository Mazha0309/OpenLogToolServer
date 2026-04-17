import { LogRepository, DictionaryRepository, DeviceRepository, UserRepository, SyncRecordRepository } from '../database/index.js';
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

  async pushSync(logs, deviceId) {
    const mapping = {};
    for (const log of logs) {
      const result = await this.logRepo.upsert(log, deviceId);
      mapping[log.localId || log.id] = result.id;
    }
    await this.deviceRepo.upsert(deviceId, deviceId);
    if (this.syncRecordRepo) {
      await this.syncRecordRepo.create(deviceId, 'push', logs.length);
    }
    return { success: true, mapping, lastSync: new Date().toISOString() };
  }

  async pullSync(deviceId, since) {
    const logs = await this.logRepo.findSince(deviceId, since);
    return { success: true, logs, lastSync: new Date().toISOString() };
  }

  async bidirectionalSync(localLogs, deviceId) {
    const strategy = process.env.SYNC_STRATEGY || 'server-wins';
    const serverLogs = await this.logRepo.findSince(deviceId, '1970-01-01T00:00:00.000Z');
    const serverLogMap = new Map(serverLogs.map(l => [l.localId || l.id, l]));

    const mergedLogs = [...serverLogs];
    const mapping = {};

    for (const localLog of localLogs) {
      const serverLog = serverLogMap.get(localLog.localId || localLog.id);
      if (!serverLog) {
        const result = await this.logRepo.upsert(localLog, deviceId);
        mapping[localLog.localId || localLog.id] = result.id;
        mergedLogs.push(localLog);
      } else if (strategy === 'client-wins') {
        const serverTime = new Date(serverLog.updatedAt).getTime();
        const localTime = new Date(localLog.updatedAt || localLog.createdAt).getTime();
        if (localTime > serverTime) {
          const result = await this.logRepo.upsert(localLog, deviceId);
          mapping[localLog.localId || localLog.id] = result.id;
        }
      }
    }

    await this.deviceRepo.upsert(deviceId, deviceId);
    if (this.syncRecordRepo) {
      await this.syncRecordRepo.create(deviceId, 'bidirectional', localLogs.length);
    }

    return { success: true, logs: mergedLogs, mapping, lastSync: new Date().toISOString() };
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
