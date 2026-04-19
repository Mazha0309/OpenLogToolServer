/**
 * @fileoverview MongoDB 数据库适配器
 */

import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

// 定义 Schema
const logSchema = new mongoose.Schema({
  deviceId: { type: String, index: true },
  userId: { type: String, index: true },
  localId: { type: String },
  time: { type: Date, required: true },
  controller: { type: String, required: true, maxlength: 100 },
  callsign: { type: String, required: true, maxlength: 20, index: true },
  report: { type: String },
  qth: { type: String },
  device: { type: String },
  power: { type: String },
  antenna: { type: String },
  height: { type: String },
}, {
  timestamps: true,
  collection: 'logs',
});

logSchema.index({ deviceId: 1, userId: 1 });
logSchema.index({ deviceId: 1, localId: 1 });

const dictionarySchema = new mongoose.Schema({
  userId: { type: String, index: true },
  type: { type: String, enum: ['device', 'antenna', 'qth', 'callsign'], required: true, index: true },
  raw: { type: String, required: true, maxlength: 200 },
  pinyin: { type: String, maxlength: 200 },
  abbreviation: { type: String, maxlength: 50 },
}, {
  timestamps: true,
  collection: 'dictionaries',
});

dictionarySchema.index({ userId: 1, type: 1, raw: 1 }, { unique: true });

const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, unique: true, required: true, index: true },
  name: { type: String },
  lastSyncAt: { type: Date },
}, {
  timestamps: true,
  collection: 'devices',
});

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  role: { type: String, default: 'admin' },
}, {
  timestamps: true,
  collection: 'users',
});

const syncRecordSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, index: true },
  syncType: { type: String, enum: ['push', 'pull', 'bidirectional'], required: true },
  recordsCount: { type: Number, default: 0 },
}, {
  timestamps: true,
  collection: 'sync_records',
});

const shareSchema = new mongoose.Schema({
  fromUserId: { type: String, required: true, index: true },
  toUserId: { type: String, required: true, index: true },
  shareType: { type: String, enum: ['logs', 'dictionaries', 'both'], required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  itemIds: { type: [String], default: null },
  autoSync: { type: Boolean, default: false },
}, {
  timestamps: true,
  collection: 'shares',
});

const callsignQthHistorySchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  callsign: { type: String, required: true, maxlength: 64, index: true },
  qth: { type: String, required: true, maxlength: 128 },
  timestamp: { type: Date, default: Date.now },
}, {
  timestamps: true,
  collection: 'callsign_qth_history',
});

callsignQthHistorySchema.index({ userId: 1, callsign: 1 });
callsignQthHistorySchema.index({ userId: 1, timestamp: 1 });

export class MongodbAdapter {
  constructor(config) {
    this.config = config;
    this.connected = false;
  }

  async connect() {
    if (this.connected) return this;

    const { host, port, database, username, password } = this.config;
    const authPart = username && password ? `${username}:${password}@` : '';
    const uri = `mongodb://${authPart}${host}:${port}/${database}`;

    await mongoose.connect(uri);
    this.connected = true;

    // 缓存模型
    this.Log = mongoose.models.Log || mongoose.model('Log', logSchema);
    this.Dictionary = mongoose.models.Dictionary || mongoose.model('Dictionary', dictionarySchema);
    this.Device = mongoose.models.Device || mongoose.model('Device', deviceSchema);
    this.User = mongoose.models.User || mongoose.model('User', userSchema);
    this.SyncRecord = mongoose.models.SyncRecord || mongoose.model('SyncRecord', syncRecordSchema);
    this.Share = mongoose.models.Share || mongoose.model('Share', shareSchema);
    this.CallsignQthHistory = mongoose.models.CallsignQthHistory || mongoose.model('CallsignQthHistory', callsignQthHistorySchema);

    return this;
  }

  async disconnect() {
    if (this.connected) {
      await mongoose.disconnect();
      this.connected = false;
    }
  }

  // 日志操作
  async findLogs(query = {}, pagination = { page: 1, pageSize: 20 }) {
    const { page, pageSize } = pagination;
    const filter = {};

    if (query.callsign) {
      filter.callsign = { $regex: query.callsign, $options: 'i' };
    }
    if (query.controller) {
      filter.controller = { $regex: query.controller, $options: 'i' };
    }
    if (query.deviceId) {
      filter.deviceId = query.deviceId;
    }
    if (query.userId) {
      filter.userId = query.userId;
    }

    const [data, total] = await Promise.all([
      this.Log.find(filter)
        .sort({ time: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      this.Log.countDocuments(filter),
    ]);

    return {
      data: data.map(this._mapLog),
      total,
      page,
      pageSize,
    };
  }

  async findLogById(id) {
    const log = await this.Log.findById(id).lean();
    return log ? this._mapLog(log) : null;
  }

  async createLog(data) {
    const log = await this.Log.create({
      deviceId: data.deviceId,
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
    });
    return this._mapLog(log.toObject());
  }

  async updateLog(id, data) {
    const log = await this.Log.findByIdAndUpdate(id, {
      time: data.time,
      controller: data.controller,
      callsign: data.callsign,
      report: data.report,
      qth: data.qth,
      device: data.device,
      power: data.power,
      antenna: data.antenna,
      height: data.height,
    }, { new: true }).lean();
    return log ? this._mapLog(log) : null;
  }

  async deleteLog(id) {
    const result = await this.Log.findByIdAndDelete(id);
    return result !== null;
  }

  async upsertLog(data, deviceId, userId) {
    const { localId, ...rest } = data;
    let log;
    if (localId) {
      log = await this.Log.findOneAndUpdate(
        { localId, deviceId },
        { ...rest, deviceId, userId, localId },
        { new: true, upsert: true }
      ).lean();
    } else {
      log = await this.Log.create({ ...rest, deviceId, userId, localId });
      log = log.toObject();
    }
    return this._mapLog(log);
  }

  async findSince(deviceId, timestamp, userId) {
    const logs = await this.Log.find({
      deviceId,
      userId,
      updatedAt: { $gt: new Date(timestamp) },
    }).sort({ updatedAt: 1 }).lean();
    return logs.map(this._mapLog);
  }

  _mapLog(doc) {
    return {
      id: doc._id.toString(),
      deviceId: doc.deviceId,
      userId: doc.userId,
      localId: doc.localId,
      time: doc.time,
      controller: doc.controller,
      callsign: doc.callsign,
      report: doc.report,
      qth: doc.qth,
      device: doc.device,
      power: doc.power,
      antenna: doc.antenna,
      height: doc.height,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  // 词典操作
  async findDictionaries(type, query = {}) {
    const filter = {};
    if (type) filter.type = type;
    if (query.userId) filter.userId = query.userId;
    if (query.search) {
      filter.$or = [
        { raw: { $regex: query.search, $options: 'i' } },
        { pinyin: { $regex: query.search, $options: 'i' } },
        { abbreviation: { $regex: query.search, $options: 'i' } },
      ];
    }

    const data = await this.Dictionary.find(filter).sort({ raw: 1 }).lean();
    return data.map(this._mapDictionary);
  }

  async findDictionaryById(id) {
    const dict = await this.Dictionary.findById(id).lean();
    return dict ? this._mapDictionary(dict) : null;
  }

  async createDictionary(type, data) {
    const dict = await this.Dictionary.create({
      userId: data.userId,
      type,
      raw: data.raw,
      pinyin: data.pinyin,
      abbreviation: data.abbreviation,
    });
    return this._mapDictionary(dict.toObject());
  }

  async updateDictionary(id, data) {
    const dict = await this.Dictionary.findByIdAndUpdate(id, {
      raw: data.raw,
      pinyin: data.pinyin,
      abbreviation: data.abbreviation,
    }, { new: true }).lean();
    return dict ? this._mapDictionary(dict) : null;
  }

  async deleteDictionary(id) {
    const result = await this.Dictionary.findByIdAndDelete(id);
    return result !== null;
  }

  async bulkCreateDictionary(type, items) {
    const docs = items.map(item => ({
      type,
      raw: item.raw,
      pinyin: item.pinyin,
      abbreviation: item.abbreviation,
    }));
    await this.Dictionary.insertMany(docs, { ordered: false });
    return this.findDictionaries(type);
  }

  async bulkUpsertDictionary(items, userId) {
    for (const item of items) {
      const existing = await this.Dictionary.findOne({
        userId,
        type: item.type,
        raw: item.raw,
      });
      if (existing) {
        await this.updateDictionary(existing._id.toString(), item);
      } else {
        await this.createDictionary(item.type, { ...item, userId });
      }
    }
  }

  async findDictionariesByUser(userId) {
    const data = await this.Dictionary.find({ userId }).sort({ raw: 1 }).lean();
    return data.map(this._mapDictionary);
  }

  _mapDictionary(doc) {
    return {
      id: doc._id.toString(),
      userId: doc.userId,
      type: doc.type,
      raw: doc.raw,
      pinyin: doc.pinyin,
      abbreviation: doc.abbreviation,
      createdAt: doc.createdAt,
    };
  }

  // 设备操作
  async findDevices() {
    const devices = await this.Device.find().sort({ lastSyncAt: -1 }).lean();
    return devices.map(d => ({
      id: d._id.toString(),
      deviceId: d.deviceId,
      name: d.name,
      lastSyncAt: d.lastSyncAt,
      createdAt: d.createdAt,
    }));
  }

  async upsertDevice(deviceId, name) {
    const device = await this.Device.findOneAndUpdate(
      { deviceId },
      { deviceId, name: name || deviceId, lastSyncAt: new Date() },
      { new: true, upsert: true }
    ).lean();
    return {
      id: device._id.toString(),
      deviceId: device.deviceId,
      name: device.name,
      lastSyncAt: device.lastSyncAt,
      createdAt: device.createdAt,
    };
  }

  // 用户操作
  async findUserByUsername(username) {
    const user = await this.User.findOne({ username }).lean();
    return user ? this._mapUser(user) : null;
  }

  async createUser(username, passwordHash) {
    const user = await this.User.create({ username, passwordHash });
    return this._mapUser(user.toObject());
  }

  _mapUser(doc) {
    return {
      id: doc._id.toString(),
      username: doc.username,
      passwordHash: doc.passwordHash,
      role: doc.role,
      createdAt: doc.createdAt,
    };
  }

  // 统计操作
  async getStats() {
    const [totalLogs, totalDictionaries, totalDevices, todayLogs, weekLogs] = await Promise.all([
      this.Log.countDocuments(),
      this.Dictionary.countDocuments(),
      this.Device.countDocuments(),
      this.Log.countDocuments({ createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
      this.Log.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
    ]);

    return {
      totalLogs,
      totalDictionaries,
      totalDevices,
      todayLogs,
      weekLogs,
    };
  }

  // 同步记录
  async createSyncRecord(deviceId, syncType, recordsCount) {
    await this.SyncRecord.create({ deviceId, syncType, recordsCount });
  }

  async getSyncRecords(limit = 50) {
    const records = await this.SyncRecord.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return records.map(r => ({
      id: r._id.toString(),
      deviceId: r.deviceId,
      syncType: r.syncType,
      recordsCount: r.recordsCount,
      syncedAt: r.createdAt,
    }));
  }

  async findShares(query = {}) {
    const filter = {};
    if (query.fromUserId) filter.fromUserId = query.fromUserId;
    if (query.toUserId) filter.toUserId = query.toUserId;
    const shares = await this.Share.find(filter).lean();
    return shares.map(this._mapShare);
  }

  async createShare(data) {
    const share = await this.Share.create({
      fromUserId: data.fromUserId,
      toUserId: data.toUserId,
      shareType: data.shareType,
      status: data.status || 'active',
      itemIds: data.itemIds,
    });
    return this._mapShare(share.toObject());
  }

  async updateShare(id, data) {
    const update = {};
    if (data.shareType !== undefined) update.shareType = data.shareType;
    if (data.itemIds !== undefined) update.itemIds = data.itemIds;
    if (data.status !== undefined) update.status = data.status;
    if (data.autoSync !== undefined) update.autoSync = data.autoSync;
    const share = await this.Share.findByIdAndUpdate(id, update, { new: true }).lean();
    return share ? this._mapShare(share) : null;
  }

  async deleteShare(id) {
    const result = await this.Share.findByIdAndDelete(id);
    return result !== null;
  }

  async findSharedLogs(fromUserId, toUserId) {
    const shares = await this.Share.find({
      fromUserId,
      toUserId,
      shareType: { $in: ['logs', 'both'] },
    }).lean();
    const itemIds = [];
    for (const s of shares) {
      if (s.itemIds == null) return null;
      if (Array.isArray(s.itemIds)) itemIds.push(...s.itemIds);
    }
    return itemIds;
  }

  async findSharedDictionaries(fromUserId, toUserId) {
    const shares = await this.Share.find({
      fromUserId,
      toUserId,
      shareType: { $in: ['dictionaries', 'both'] },
    }).lean();
    const itemIds = [];
    for (const s of shares) {
      if (s.itemIds == null) return null;
      if (Array.isArray(s.itemIds)) itemIds.push(...s.itemIds);
    }
    return itemIds;
  }

  async addCallsignQthRecord(callsign, qth, userId) {
    const existing = await this.CallsignQthHistory.findOne({
      userId,
      callsign: callsign.toUpperCase(),
      qth,
    });
    if (existing) {
      existing.timestamp = new Date();
      await existing.save();
      return this._mapCallsignQth(existing.toObject());
    }
    const record = await this.CallsignQthHistory.create({
      userId,
      callsign: callsign.toUpperCase(),
      qth,
      timestamp: new Date(),
    });
    return this._mapCallsignQth(record.toObject());
  }

  async getCallsignQthHistory(callsign, userId) {
    const records = await this.CallsignQthHistory.find({
      callsign: callsign.toUpperCase(),
      userId,
    }).sort({ timestamp: -1 }).lean();
    return records.map(this._mapCallsignQth);
  }

  async getAllCallsignQthHistory(userId) {
    const records = await this.CallsignQthHistory.find({ userId })
      .sort({ timestamp: -1 }).lean();
    return records.map(this._mapCallsignQth);
  }

  async clearCallsignQthHistory(userId) {
    await this.CallsignQthHistory.deleteMany({ userId });
  }

  async findCallsignQthHistorySince(timestamp, userId) {
    const records = await this.CallsignQthHistory.find({
      userId,
      timestamp: { $gt: new Date(timestamp) },
    }).sort({ timestamp: 1 }).lean();
    return records.map(this._mapCallsignQth);
  }

  _mapCallsignQth(doc) {
    return {
      id: doc._id.toString(),
      userId: doc.userId,
      callsign: doc.callsign,
      qth: doc.qth,
      timestamp: doc.timestamp,
    };
  }

  _mapShare(doc) {
    return {
      id: doc._id.toString(),
      fromUserId: doc.fromUserId,
      toUserId: doc.toUserId,
      shareType: doc.shareType,
      status: doc.status,
      itemIds: doc.itemIds,
      autoSync: doc.autoSync ?? false,
      createdAt: doc.createdAt,
    };
  }
}
