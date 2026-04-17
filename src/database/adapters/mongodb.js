/**
 * @fileoverview MongoDB 数据库适配器
 */

import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

// 定义 Schema
const logSchema = new mongoose.Schema({
  deviceId: { type: String, index: true },
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

const dictionarySchema = new mongoose.Schema({
  type: { type: String, enum: ['device', 'antenna', 'qth', 'callsign'], required: true, index: true },
  raw: { type: String, required: true, maxlength: 200 },
  pinyin: { type: String, maxlength: 200 },
  abbreviation: { type: String, maxlength: 50 },
}, {
  timestamps: true,
  collection: 'dictionaries',
});

dictionarySchema.index({ type: 1, raw: 1 }, { unique: true });

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

  async upsertLog(data, deviceId) {
    const { localId, ...rest } = data;
    let log;
    if (localId) {
      log = await this.Log.findOneAndUpdate(
        { localId, deviceId },
        { ...rest, deviceId, localId },
        { new: true, upsert: true }
      ).lean();
    } else {
      log = await this.Log.create({ ...rest, deviceId, localId });
      log = log.toObject();
    }
    return this._mapLog(log);
  }

  async findSince(deviceId, timestamp) {
    const logs = await this.Log.find({
      deviceId,
      updatedAt: { $gt: new Date(timestamp) },
    }).sort({ updatedAt: 1 }).lean();
    return logs.map(this._mapLog);
  }

  _mapLog(doc) {
    return {
      id: doc._id.toString(),
      deviceId: doc.deviceId,
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

  _mapDictionary(doc) {
    return {
      id: doc._id.toString(),
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
}
