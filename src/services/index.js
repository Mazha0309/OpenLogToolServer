import { LogRepository, DictionaryRepository, DeviceRepository, UserRepository, SyncRecordRepository, ShareRepository, CallsignQthRepository, HistoryRepository, SessionRepository } from '../database/index.js';
import connector from '../database/connector.js';
import { toSyncProtocolFields, fromSyncProtocolFields, nestDictionaries, flattenDictionaries, applyIncomingRecord } from '../utils/sync-helpers.js';

export class SyncService {
  constructor() {
    this.logRepo = null;
    this.dictRepo = null;
    this.deviceRepo = null;
    this.syncRecordRepo = null;
    this.callsignQthRepo = null;
    this.historyRepo = null;
    this.sessionRepo = null;
  }

  async init() {
    const adapter = await connector.connect();
    this.logRepo = new LogRepository(adapter);
    this.dictRepo = new DictionaryRepository(adapter);
    this.deviceRepo = new DeviceRepository(adapter);
    this.syncRecordRepo = new SyncRecordRepository(adapter);
    this.callsignQthRepo = new CallsignQthRepository(adapter);
    this.historyRepo = new HistoryRepository(adapter);
    this.sessionRepo = new SessionRepository(adapter);
  }

  async pushSync(payload, deviceId, userId) {
    const normalized = this._normalizePayload(payload);
    const summary = { received: {}, applied: {}, ignored: {}, conflicts: 0 };

    const sessionStats = await this._mergeCollection(
      normalized.sessions,
      item => this.sessionRepo.findBySessionId(item.session_id ?? item.sessionId),
      item => this.sessionRepo.upsert(item, userId),
    );
    summary.received.sessions = sessionStats.received;
    summary.applied.sessions = sessionStats.applied;
    summary.ignored.sessions = sessionStats.ignored;
    summary.conflicts += sessionStats.conflicts;

    const logStats = await this._mergeCollection(
      normalized.logs,
      item => this.logRepo.findBySyncId(item.syncId ?? item.id),
      item => this.logRepo.upsert(item, deviceId, userId),
    );
    summary.received.logs = logStats.received;
    summary.applied.logs = logStats.applied;
    summary.ignored.logs = logStats.ignored;
    summary.conflicts += logStats.conflicts;

    const dictStats = await this._mergeCollection(
      normalized.dictionaries,
      item => this.dictRepo.findBySyncId(item.syncId ?? item.id),
      item => this.dictRepo.upsert(item, userId),
    );
    summary.received.dictionaries = dictStats.received;
    summary.applied.dictionaries = dictStats.applied;
    summary.ignored.dictionaries = dictStats.ignored;
    summary.conflicts += dictStats.conflicts;

    const cqthStats = await this._mergeCollection(
      normalized.callsignQthHistory,
      item => this.callsignQthRepo.findBySyncId(item.syncId ?? item.id),
      item => this.callsignQthRepo.upsert(item, userId),
    );
    summary.received.callsignQthHistory = cqthStats.received;
    summary.applied.callsignQthHistory = cqthStats.applied;
    summary.ignored.callsignQthHistory = cqthStats.ignored;
    summary.conflicts += cqthStats.conflicts;

    const histStats = await this._mergeCollection(
      normalized.history,
      item => this.historyRepo.findBySyncId(item.syncId ?? item.id),
      item => this.historyRepo.upsert(item, userId),
    );
    summary.received.history = histStats.received;
    summary.applied.history = histStats.applied;
    summary.ignored.history = histStats.ignored;
    summary.conflicts += histStats.conflicts;

    const totalApplied = summary.applied.sessions
      + summary.applied.logs
      + summary.applied.dictionaries
      + summary.applied.callsignQthHistory
      + summary.applied.history;

    await this.deviceRepo.upsert(deviceId, deviceId);
    if (this.syncRecordRepo) {
      await this.syncRecordRepo.create(deviceId, 'push', totalApplied, summary);
    }

    return { ok: true, serverTime: new Date().toISOString(), summary };
  }

  async pullSync(since, userId) {
    const [sessions, logs, dictionaries, callsignQthHistory, history] = await Promise.all([
      this.sessionRepo.findSince(since, userId),
      this.logRepo.findSince(since, userId),
      this.dictRepo.findSince(since, userId),
      this.callsignQthRepo.findSince(since, userId),
      this.historyRepo.findSince(since, userId),
    ]);

    const serverTime = new Date().toISOString();
    return {
      ok: true,
      serverTime,
      changes: {
        sessions: sessions.map(toSyncProtocolFields),
        logs: logs.map(toSyncProtocolFields),
        dictionaries: nestDictionaries(dictionaries),
        callsignQthHistory: callsignQthHistory.map(toSyncProtocolFields),
        history: history.map(toSyncProtocolFields),
      },
      nextSyncToken: { lastSyncAt: serverTime },
    };
  }

  async bidirectionalSync(payload, deviceId, userId, lastSyncAt = '1970-01-01T00:00:00.000Z') {
    const normalized = this._normalizePayload(payload);
    const summary = { received: {}, applied: {}, ignored: {}, conflicts: 0 };

    const [serverSessions, serverLogs, serverDictionaries, serverCallsignQthHistory, serverHistory] = await Promise.all([
      this.sessionRepo.findSince(lastSyncAt, userId),
      this.logRepo.findSince(lastSyncAt, userId),
      this.dictRepo.findSince(lastSyncAt, userId),
      this.callsignQthRepo.findSince(lastSyncAt, userId),
      this.historyRepo.findSince(lastSyncAt, userId),
    ]);

    const sessionStats = await this._mergeCollection(
      normalized.sessions,
      item => this.sessionRepo.findBySessionId(item.session_id ?? item.sessionId),
      item => this.sessionRepo.upsert(item, userId),
    );
    summary.received.sessions = sessionStats.received;
    summary.applied.sessions = sessionStats.applied;
    summary.ignored.sessions = sessionStats.ignored;
    summary.conflicts += sessionStats.conflicts;

    const logStats = await this._mergeCollection(
      normalized.logs,
      item => this.logRepo.findBySyncId(item.syncId ?? item.id),
      item => this.logRepo.upsert(item, deviceId, userId),
    );
    summary.received.logs = logStats.received;
    summary.applied.logs = logStats.applied;
    summary.ignored.logs = logStats.ignored;
    summary.conflicts += logStats.conflicts;

    const dictStats = await this._mergeCollection(
      normalized.dictionaries,
      item => this.dictRepo.findBySyncId(item.syncId ?? item.id),
      item => this.dictRepo.upsert(item, userId),
    );
    summary.received.dictionaries = dictStats.received;
    summary.applied.dictionaries = dictStats.applied;
    summary.ignored.dictionaries = dictStats.ignored;
    summary.conflicts += dictStats.conflicts;

    const cqthStats = await this._mergeCollection(
      normalized.callsignQthHistory,
      item => this.callsignQthRepo.findBySyncId(item.syncId ?? item.id),
      item => this.callsignQthRepo.upsert(item, userId),
    );
    summary.received.callsignQthHistory = cqthStats.received;
    summary.applied.callsignQthHistory = cqthStats.applied;
    summary.ignored.callsignQthHistory = cqthStats.ignored;
    summary.conflicts += cqthStats.conflicts;

    const histStats = await this._mergeCollection(
      normalized.history,
      item => this.historyRepo.findBySyncId(item.syncId ?? item.id),
      item => this.historyRepo.upsert(item, userId),
    );
    summary.received.history = histStats.received;
    summary.applied.history = histStats.applied;
    summary.ignored.history = histStats.ignored;
    summary.conflicts += histStats.conflicts;

    const totalApplied = summary.applied.sessions
      + summary.applied.logs
      + summary.applied.dictionaries
      + summary.applied.callsignQthHistory
      + summary.applied.history;

    await this.deviceRepo.upsert(deviceId, deviceId);
    if (this.syncRecordRepo) {
      await this.syncRecordRepo.create(deviceId, 'bidirectional', totalApplied, {
        since: lastSyncAt,
        ...summary,
        download: {
          sessions: serverSessions.length,
          logs: serverLogs.length,
          dictionaries: serverDictionaries.length,
          callsignQthHistory: serverCallsignQthHistory.length,
          history: serverHistory.length,
        },
      });
    }

    const serverTime = new Date().toISOString();
    return {
      ok: true,
      serverTime,
      summary,
      changes: {
        sessions: serverSessions.map(toSyncProtocolFields),
        logs: serverLogs.map(toSyncProtocolFields),
        dictionaries: nestDictionaries(serverDictionaries),
        callsignQthHistory: serverCallsignQthHistory.map(toSyncProtocolFields),
        history: serverHistory.map(toSyncProtocolFields),
      },
      nextSyncToken: { lastSyncAt: serverTime },
    };
  }

  _normalizePayload(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { logs: [], dictionaries: [], callsignQthHistory: [], history: [], sessions: [] };
    }

    let dictionaries;
    if (payload.dictionaries && !Array.isArray(payload.dictionaries) && typeof payload.dictionaries === 'object') {
      dictionaries = flattenDictionaries(payload.dictionaries);
    } else {
      dictionaries = Array.isArray(payload.dictionaries) ? payload.dictionaries : [];
    }

    return {
      logs: Array.isArray(payload.logs) ? payload.logs.map(fromSyncProtocolFields) : [],
      dictionaries,
      callsignQthHistory: Array.isArray(payload.callsignQthHistory) ? payload.callsignQthHistory.map(fromSyncProtocolFields) : [],
      history: Array.isArray(payload.history) ? payload.history.map(fromSyncProtocolFields) : [],
      sessions: Array.isArray(payload.sessions) ? payload.sessions.map(fromSyncProtocolFields) : [],
    };
  }

  async _mergeCollection(items, findExistingFn, upsertFn) {
    let received = 0;
    let applied = 0;
    let ignored = 0;
    let conflicts = 0;

    for (const item of items) {
      received++;
      try {
        const existing = await findExistingFn(item);
        const decision = applyIncomingRecord(existing, item);
        if (decision.conflict) {
          conflicts++;
        }

        if (decision.action === 'ignore' || decision.action === 'ignore_keep_server') {
          ignored++;
          continue;
        }

        const result = await upsertFn(item);
        if (result != null) {
          applied++;
        } else {
          ignored++;
        }
      } catch (e) {
        console.error('_mergeCollection error:', e?.message || e);
        ignored++;
      }
    }

    return { received, applied, ignored, conflicts };
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

  async listLogs(query, pagination, userId) {
    const scopedQuery = userId ? { ...query, userId } : query;
    return this.repo.findAll(scopedQuery, pagination);
  }

  async getLog(id, userId) {
    const log = await this.repo.findById(id);
    if (!log) {
      return null;
    }
    if (userId && log.userId !== userId) {
      return null;
    }
    if (log.deletedAt) {
      return null;
    }
    return log;
  }

  async createLog(data, userId) {
    return this.repo.create({ ...data, userId });
  }

  async updateLog(id, data, userId) {
    const existing = await this.repo.findById(id);
    if (!existing) {
      return null;
    }
    if (userId && existing.userId !== userId) {
      return null;
    }
    return this.repo.update(id, { ...data, userId: existing.userId });
  }

  async deleteLog(id, userId) {
    const existing = await this.repo.findById(id);
    if (!existing) {
      return false;
    }
    if (userId && existing.userId !== userId) {
      return false;
    }
    return this.repo.softDelete(id, new Date().toISOString(), existing.userId);
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

  async listDictionaries(type, query, userId) {
    const scopedQuery = userId ? { ...query, userId } : query;
    return this.repo.findAll(type, scopedQuery);
  }

  async createDictionary(type, data, userId) {
    return this.repo.create(type, { ...data, userId });
  }

  async updateDictionary(id, data, userId) {
    const existing = await this.repo.findById(id);
    if (!existing) {
      return null;
    }
    if (userId && existing.userId !== userId) {
      return null;
    }
    return this.repo.update(id, { ...data, userId: existing.userId });
  }

  async deleteDictionary(id, userId) {
    const existing = await this.repo.findById(id);
    if (!existing) {
      return null;
    }
    if (userId && existing.userId !== userId) {
      return null;
    }
    return this.repo.softDelete(id, new Date().toISOString(), existing.userId);
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
