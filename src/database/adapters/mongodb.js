/**
 * @fileoverview MongoDB 数据库适配器
 */

import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const toDate = value => {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
};

const latestTimestamp = (...values) => {
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

  if (!incoming || !existing) {
    return true;
  }

  return incoming.getTime() >= existing.getTime();
};

const syncSchemaOptions = collection => ({
  timestamps: true,
  collection,
});

const logSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  deviceId: { type: String, index: true },
  sourceDeviceId: { type: String, index: true },
  syncId: { type: String, default: null },
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
  clientUpdatedAt: { type: Date, default: null },
  serverUpdatedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null, index: true },
  sessionId: { type: String, default: null },
}, syncSchemaOptions('logs'));

logSchema.index({ deviceId: 1, userId: 1 });
logSchema.index({ sourceDeviceId: 1, localId: 1 });

const dictionarySchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  userId: { type: String, index: true },
  syncId: { type: String, default: null },
  sourceDeviceId: { type: String, default: null },
  type: { type: String, enum: ['device', 'antenna', 'qth', 'callsign'], required: true, index: true },
  raw: { type: String, required: true, maxlength: 200 },
  pinyin: { type: String, maxlength: 200 },
  abbreviation: { type: String, maxlength: 50 },
  clientUpdatedAt: { type: Date, default: null },
  serverUpdatedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null, index: true },
}, syncSchemaOptions('dictionaries'));

dictionarySchema.index({ userId: 1, type: 1, raw: 1 }, { unique: true });

const deviceSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  deviceId: { type: String, unique: true, required: true, index: true },
  name: { type: String },
  lastSyncAt: { type: Date },
}, syncSchemaOptions('devices'));

const userSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  role: { type: String, default: 'admin' },
  parentId: { type: String, default: null },
  theme: { type: String, default: 'light' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, syncSchemaOptions('users'));

const syncRecordSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  deviceId: { type: String, required: true, index: true },
  syncType: { type: String, enum: ['push', 'pull', 'bidirectional'], required: true },
  recordsCount: { type: Number, default: 0 },
  details: { type: mongoose.Schema.Types.Mixed, default: null },
}, syncSchemaOptions('sync_records'));

const shareSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  fromUserId: { type: String, required: true, index: true },
  toUserId: { type: String, required: true, index: true },
  shareType: { type: String, enum: ['logs', 'dictionaries', 'both'], required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  itemIds: { type: [String], default: null },
  autoSync: { type: Boolean, default: false },
}, syncSchemaOptions('shares'));

const callsignQthHistorySchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  userId: { type: String, required: true, index: true },
  syncId: { type: String, default: null },
  sourceDeviceId: { type: String, default: null },
  callsign: { type: String, required: true, maxlength: 64, index: true },
  qth: { type: String, required: true, maxlength: 128 },
  timestamp: { type: Date, default: Date.now },
  recordedAt: { type: Date, default: Date.now, index: true },
  clientUpdatedAt: { type: Date, default: null },
  serverUpdatedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null, index: true },
}, syncSchemaOptions('callsign_qth_history'));

callsignQthHistorySchema.index({ userId: 1, callsign: 1 });
callsignQthHistorySchema.index({ userId: 1, recordedAt: 1 });

const historySchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  userId: { type: String, required: true, index: true },
  syncId: { type: String, default: null },
  sourceDeviceId: { type: String, default: null },
  name: { type: String, required: true, maxlength: 255 },
  logsData: { type: String, required: true },
  logCount: { type: Number, default: 0 },
  clientUpdatedAt: { type: Date, default: null },
  serverUpdatedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null, index: true },
}, syncSchemaOptions('history'));

historySchema.index({ userId: 1, updatedAt: 1 });

const sessionSchema = new mongoose.Schema({
  session_id: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  status: { type: String, enum: ['active', 'closed', 'archived'], default: 'active' },
  created_at: { type: Date, required: true },
  updated_at: { type: Date, required: true },
  closed_at: Date,
  deleted_at: Date,
  source_device_id: String,
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

const publicLinkSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  session_id: { type: String, required: true },
  user_id: { type: String, required: true },
  share_code: { type: String, unique: true, required: true },
  enabled: { type: Number, default: 1 },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  expires_at: Date,
  revoked_at: Date,
  view_options_json: { type: String, default: '{}' },
}, syncSchemaOptions('public_links'));

const changeLogSchema = new mongoose.Schema({
  change_id: { type: Number },
  session_id: { type: String, required: true },
  entity_type: { type: String, required: true },
  entity_sync_id: { type: String, required: true },
  action: { type: String, required: true },
  payload_json: { type: String, required: true },
  source_device_id: String,
  server_created_at: { type: Date, default: Date.now },
}, syncSchemaOptions('change_log'));

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

    this.Log = mongoose.models.Log || mongoose.model('Log', logSchema);
    this.Dictionary = mongoose.models.Dictionary || mongoose.model('Dictionary', dictionarySchema);
    this.Device = mongoose.models.Device || mongoose.model('Device', deviceSchema);
    this.User = mongoose.models.User || mongoose.model('User', userSchema);
    this.SyncRecord = mongoose.models.SyncRecord || mongoose.model('SyncRecord', syncRecordSchema);
    this.Share = mongoose.models.Share || mongoose.model('Share', shareSchema);
    this.CallsignQthHistory = mongoose.models.CallsignQthHistory || mongoose.model('CallsignQthHistory', callsignQthHistorySchema);
    this.History = mongoose.models.History || mongoose.model('History', historySchema);
    this.Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
    this.PublicLink = mongoose.models.PublicLink || mongoose.model('PublicLink', publicLinkSchema);
    this.ChangeLog = mongoose.models.ChangeLog || mongoose.model('ChangeLog', changeLogSchema);

    const existingAdmin = await this.User.findOne({ username: 'admin' });
    if (!existingAdmin) {
      const bcrypt = (await import('bcryptjs')).default;
      const hash = bcrypt.hashSync('admin123', 10);
      await this.User.create({ username: 'admin', passwordHash: hash, role: 'admin' });
    }

    return this;
  }

  async disconnect() {
    if (this.connected) {
      await mongoose.disconnect();
      this.connected = false;
    }
  }

  async findLogs(query = {}, pagination = { page: 1, pageSize: 20 }) {
    const { page, pageSize } = pagination;
    const filter = {};

    if (!query.includeDeleted) {
      filter.deletedAt = null;
    }
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
    if (query.sessionId) {
      filter.sessionId = query.sessionId;
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
      data: data.map(doc => this._mapLog(doc)),
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
    const id = data.id || uuidv4();
    const log = await this.Log.create({
      _id: id,
      deviceId: data.sourceDeviceId ?? data.deviceId ?? null,
      sourceDeviceId: data.sourceDeviceId ?? data.deviceId ?? null,
      syncId: data.syncId ?? data.id ?? id,
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
      createdAt: toDate(data.createdAt) || new Date(),
      updatedAt: toDate(data.updatedAt) || toDate(data.createdAt) || new Date(),
      deletedAt: toDate(data.deletedAt),
      sessionId: data.sessionId ?? null,
    });
    return this._mapLog(log.toObject());
  }

  async updateLog(id, data) {
    const update = {};
    if (data.sourceDeviceId !== undefined || data.deviceId !== undefined) {
      update.deviceId = data.sourceDeviceId ?? data.deviceId;
      update.sourceDeviceId = data.sourceDeviceId ?? data.deviceId;
    }
    if (data.syncId !== undefined) update.syncId = data.syncId;
    if (data.userId !== undefined) update.userId = data.userId;
    if (data.localId !== undefined) update.localId = data.localId;
    if (data.time !== undefined) update.time = data.time;
    if (data.controller !== undefined) update.controller = data.controller;
    if (data.callsign !== undefined) update.callsign = data.callsign;
    if (data.report !== undefined) update.report = data.report;
    if (data.qth !== undefined) update.qth = data.qth;
    if (data.device !== undefined) update.device = data.device;
    if (data.power !== undefined) update.power = data.power;
    if (data.antenna !== undefined) update.antenna = data.antenna;
    if (data.height !== undefined) update.height = data.height;
    if (data.clientUpdatedAt !== undefined) update.clientUpdatedAt = toDate(data.clientUpdatedAt);
    if (data.serverUpdatedAt !== undefined) update.serverUpdatedAt = toDate(data.serverUpdatedAt);
    if (data.createdAt !== undefined) update.createdAt = toDate(data.createdAt);
    if (data.updatedAt !== undefined) update.updatedAt = toDate(data.updatedAt);
    if (data.deletedAt !== undefined) update.deletedAt = toDate(data.deletedAt);
    update.serverUpdatedAt = new Date();

    const log = await this.Log.findByIdAndUpdate(id, update, { new: true }).lean();
    return log ? this._mapLog(log) : null;
  }

  async deleteLog(id) {
    const result = await this.Log.findByIdAndDelete(id);
    return result !== null;
  }

  async upsertLog(data, deviceId, userId) {
    return this.upsertLogSync(data, deviceId, userId);
  }

  async upsertLogSync(data, deviceId, userId) {
    let existing = data.id ? await this.findLogById(data.id) : null;

    if (!existing && data.localId) {
      const doc = await this.Log.findOne({
        localId: data.localId,
        sourceDeviceId: data.sourceDeviceId ?? deviceId,
      }).lean();
      existing = doc ? this._mapLog(doc) : null;
    }

    if (existing) {
      const incomingUpdatedAt = latestTimestamp(data.updatedAt, data.deletedAt, data.createdAt);
      const existingUpdatedAt = latestTimestamp(existing.updatedAt, existing.deletedAt, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }

      return this.updateLog(existing.id, {
        ...data,
        userId,
        sourceDeviceId: data.sourceDeviceId ?? deviceId,
      });
    }

    return this.createLog({
      ...data,
      userId,
      deviceId: data.sourceDeviceId ?? deviceId,
      sourceDeviceId: data.sourceDeviceId ?? deviceId,
    });
  }

  async findSince(deviceId, timestamp, userId) {
    const logs = await this.Log.find({
      deviceId,
      userId,
      updatedAt: { $gt: new Date(timestamp) },
    }).sort({ updatedAt: 1 }).lean();
    return logs.map(doc => this._mapLog(doc));
  }

  async findLogsSince(timestamp, userId) {
    const since = new Date(timestamp);
    const logs = await this.Log.find({
      userId,
      $or: [
        { updatedAt: { $gt: since } },
        { deletedAt: { $gt: since } },
      ],
    }).sort({ updatedAt: 1, deletedAt: 1 }).lean();
    return logs.map(doc => this._mapLog(doc));
  }

  async softDeleteLog(id, deletedAt, userId) {
    const filter = { _id: id };
    if (userId) filter.userId = userId;

    const log = await this.Log.findOneAndUpdate(filter, {
      deletedAt: toDate(deletedAt) || new Date(),
      updatedAt: toDate(deletedAt) || new Date(),
    }, { new: true }).lean();
    return log ? this._mapLog(log) : null;
  }

  async importLogs(logs) {
    for (const log of logs) {
      await this.createLog(log);
    }
  }

  _mapLog(doc) {
    return {
      id: doc._id.toString(),
      deviceId: doc.deviceId,
      sourceDeviceId: doc.sourceDeviceId ?? doc.deviceId,
      syncId: doc.syncId ?? doc._id.toString(),
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
      clientUpdatedAt: doc.clientUpdatedAt,
      serverUpdatedAt: doc.serverUpdatedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
      sessionId: doc.sessionId,
    };
  }

  async findDictionaries(type, query = {}) {
    const filter = {};
    if (!query.includeDeleted) filter.deletedAt = null;
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
    return data.map(doc => this._mapDictionary(doc));
  }

  async findDictionaryById(id) {
    const dict = await this.Dictionary.findById(id).lean();
    return dict ? this._mapDictionary(dict) : null;
  }

  async createDictionary(type, data) {
    const id = data.id || uuidv4();
    const dict = await this.Dictionary.create({
      _id: id,
      userId: data.userId,
      syncId: data.syncId ?? data.id ?? id,
      sourceDeviceId: data.sourceDeviceId ?? null,
      type,
      raw: data.raw,
      pinyin: data.pinyin,
      abbreviation: data.abbreviation,
      clientUpdatedAt: toDate(data.clientUpdatedAt),
      serverUpdatedAt: new Date(),
      createdAt: toDate(data.createdAt) || new Date(),
      updatedAt: toDate(data.updatedAt) || toDate(data.createdAt) || new Date(),
      deletedAt: toDate(data.deletedAt),
    });
    return this._mapDictionary(dict.toObject());
  }

  async updateDictionary(id, data) {
    const update = {};
    if (data.userId !== undefined) update.userId = data.userId;
    if (data.syncId !== undefined) update.syncId = data.syncId;
    if (data.sourceDeviceId !== undefined) update.sourceDeviceId = data.sourceDeviceId;
    if (data.type !== undefined) update.type = data.type;
    if (data.raw !== undefined) update.raw = data.raw;
    if (data.pinyin !== undefined) update.pinyin = data.pinyin;
    if (data.abbreviation !== undefined) update.abbreviation = data.abbreviation;
    if (data.clientUpdatedAt !== undefined) update.clientUpdatedAt = toDate(data.clientUpdatedAt);
    if (data.serverUpdatedAt !== undefined) update.serverUpdatedAt = toDate(data.serverUpdatedAt);
    if (data.createdAt !== undefined) update.createdAt = toDate(data.createdAt);
    if (data.updatedAt !== undefined) update.updatedAt = toDate(data.updatedAt);
    if (data.deletedAt !== undefined) update.deletedAt = toDate(data.deletedAt);
    update.serverUpdatedAt = new Date();

    const dict = await this.Dictionary.findByIdAndUpdate(id, update, { new: true }).lean();
    return dict ? this._mapDictionary(dict) : null;
  }

  async deleteDictionary(id) {
    const result = await this.Dictionary.findByIdAndDelete(id);
    return result !== null;
  }

  async bulkCreateDictionary(type, items) {
    const docs = items.map(item => ({
      _id: item.id || uuidv4(),
      userId: item.userId,
      type,
      raw: item.raw,
      pinyin: item.pinyin,
      abbreviation: item.abbreviation,
      createdAt: toDate(item.createdAt) || new Date(),
      updatedAt: toDate(item.updatedAt) || toDate(item.createdAt) || new Date(),
      deletedAt: toDate(item.deletedAt),
    }));
    await this.Dictionary.insertMany(docs, { ordered: false });
    return this.findDictionaries(type);
  }

  async bulkUpsertDictionary(items, userId) {
    for (const item of items) {
      await this.upsertDictionarySync(item, userId);
    }
  }

  async findDictionariesByUser(userId) {
    const data = await this.Dictionary.find({ userId, deletedAt: null }).sort({ raw: 1 }).lean();
    return data.map(doc => this._mapDictionary(doc));
  }

  async findDictionariesSince(timestamp, userId) {
    const since = new Date(timestamp);
    const data = await this.Dictionary.find({
      userId,
      $or: [
        { updatedAt: { $gt: since } },
        { deletedAt: { $gt: since } },
      ],
    }).sort({ updatedAt: 1, deletedAt: 1 }).lean();
    return data.map(doc => this._mapDictionary(doc));
  }

  async upsertDictionarySync(item, userId) {
    let existing = item.id ? await this.findDictionaryById(item.id) : null;

    if (!existing) {
      const doc = await this.Dictionary.findOne({ userId, type: item.type, raw: item.raw }).lean();
      existing = doc ? this._mapDictionary(doc) : null;
    }

    if (existing) {
      const incomingUpdatedAt = latestTimestamp(item.updatedAt, item.deletedAt, item.createdAt);
      const existingUpdatedAt = latestTimestamp(existing.updatedAt, existing.deletedAt, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }

      return this.updateDictionary(existing.id, { ...item, userId, type: item.type ?? existing.type });
    }

    return this.createDictionary(item.type, { ...item, userId });
  }

  async softDeleteDictionary(id, deletedAt, userId) {
    const filter = { _id: id };
    if (userId) filter.userId = userId;

    const dict = await this.Dictionary.findOneAndUpdate(filter, {
      deletedAt: toDate(deletedAt) || new Date(),
      updatedAt: toDate(deletedAt) || new Date(),
    }, { new: true }).lean();
    return dict ? this._mapDictionary(dict) : null;
  }

  _mapDictionary(doc) {
    return {
      id: doc._id.toString(),
      userId: doc.userId,
      syncId: doc.syncId ?? doc._id.toString(),
      sourceDeviceId: doc.sourceDeviceId ?? null,
      type: doc.type,
      raw: doc.raw,
      pinyin: doc.pinyin,
      abbreviation: doc.abbreviation,
      clientUpdatedAt: doc.clientUpdatedAt,
      serverUpdatedAt: doc.serverUpdatedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
    };
  }

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

  async findUserByUsername(username) {
    const user = await this.User.findOne({ username }).lean();
    return user ? this._mapUser(user) : null;
  }

  async findUserById(id) {
    const user = await this.User.findById(id).lean();
    return user ? this._mapUser(user) : null;
  }

  async createUser(username, passwordHash, role = 'user', parentId = null, theme = 'light') {
    const user = await this.User.create({
      username, passwordHash, role, parentId, theme,
      createdAt: new Date(), updatedAt: new Date(),
    });
    return this._mapUser(user.toObject());
  }

  async updateUser(id, data) {
    const user = await this.User.findOneAndUpdate(
      { _id: id },
      { ...data, updatedAt: new Date() },
      { new: true }
    );
    return user ? this._mapUser(user.toObject()) : null;
  }

  async findUsersByParentId(parentId) {
    const users = await this.User.find({ parentId }).lean();
    return users.map(this._mapUser);
  }

  async findAllUsers() {
    const users = await this.User.find({}).lean();
    return users.map(this._mapUser);
  }

  async deleteUser(id) {
    const result = await this.User.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  _mapUser(doc) {
    return {
      id: doc._id?.toString() || doc.id,
      username: doc.username,
      passwordHash: doc.passwordHash,
      role: doc.role,
      parentId: doc.parentId,
      theme: doc.theme,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  async getStats() {
    const [totalLogs, totalDictionaries, totalDevices, todayLogs, weekLogs] = await Promise.all([
      this.Log.countDocuments({ deletedAt: null }),
      this.Dictionary.countDocuments({ deletedAt: null }),
      this.Device.countDocuments(),
      this.Log.countDocuments({ createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }, deletedAt: null }),
      this.Log.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, deletedAt: null }),
    ]);

    return {
      totalLogs,
      totalDictionaries,
      totalDevices,
      todayLogs,
      weekLogs,
    };
  }

  async createSyncRecord(deviceId, syncType, recordsCount, details = null) {
    await this.SyncRecord.create({ _id: uuidv4(), deviceId, syncType, recordsCount, details });
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
      details: r.details ?? null,
      syncedAt: r.createdAt,
    }));
  }

  async findShares(query = {}) {
    const filter = {};
    if (query.fromUserId) filter.fromUserId = query.fromUserId;
    if (query.toUserId) filter.toUserId = query.toUserId;
    const shares = await this.Share.find(filter).lean();
    return shares.map(doc => this._mapShare(doc));
  }

  async createShare(data) {
    const share = await this.Share.create({
      _id: uuidv4(),
      fromUserId: data.fromUserId,
      toUserId: data.toUserId,
      shareType: data.shareType,
      status: data.status || 'active',
      itemIds: data.itemIds,
      autoSync: data.autoSync ?? false,
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
    const normalizedCallsign = callsign.toUpperCase();
    const existing = await this.CallsignQthHistory.findOne({
      userId,
      callsign: normalizedCallsign,
      qth,
      deletedAt: null,
    });
    if (existing) {
      existing.timestamp = new Date();
      existing.recordedAt = new Date();
      existing.updatedAt = new Date();
      existing.serverUpdatedAt = new Date();
      existing.deletedAt = null;
      await existing.save();
      return this._mapCallsignQth(existing.toObject());
    }
    const id = uuidv4();
    const record = await this.CallsignQthHistory.create({
      _id: id,
      userId,
      syncId: id,
      sourceDeviceId: null,
      callsign: normalizedCallsign,
      qth,
      timestamp: new Date(),
      recordedAt: new Date(),
      clientUpdatedAt: null,
      serverUpdatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    return this._mapCallsignQth(record.toObject());
  }

  async getCallsignQthHistory(callsign, userId) {
    const records = await this.CallsignQthHistory.find({
      callsign: callsign.toUpperCase(),
      userId,
      deletedAt: null,
    }).sort({ recordedAt: -1 }).lean();
    return records.map(doc => this._mapCallsignQth(doc));
  }

  async getAllCallsignQthHistory(userId) {
    const records = await this.CallsignQthHistory.find({ userId, deletedAt: null })
      .sort({ recordedAt: -1 }).lean();
    return records.map(doc => this._mapCallsignQth(doc));
  }

  async clearCallsignQthHistory(userId) {
    await this.CallsignQthHistory.deleteMany({ userId });
  }

  async findCallsignQthHistorySince(timestamp, userId) {
    const since = new Date(timestamp);
    const records = await this.CallsignQthHistory.find({
      userId,
      $or: [
        { updatedAt: { $gt: since } },
        { deletedAt: { $gt: since } },
        { recordedAt: { $gt: since } },
      ],
    }).sort({ updatedAt: 1, recordedAt: 1 }).lean();
    return records.map(doc => this._mapCallsignQth(doc));
  }

  async upsertCallsignQthSync(record, userId) {
    let existing = record.id ? await this.CallsignQthHistory.findById(record.id) : null;

    if (!existing) {
      existing = await this.CallsignQthHistory.findOne({
        userId,
        callsign: record.callsign.toUpperCase(),
        qth: record.qth,
      });
    }

    if (existing) {
      const incomingUpdatedAt = latestTimestamp(record.updatedAt, record.deletedAt, record.recordedAt, record.timestamp, record.createdAt);
      const existingUpdatedAt = latestTimestamp(existing.updatedAt, existing.deletedAt, existing.recordedAt, existing.timestamp, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return this._mapCallsignQth(existing.toObject());
      }

      existing.userId = userId;
      existing.syncId = record.syncId ?? record.id ?? existing.syncId ?? existing._id.toString();
      existing.sourceDeviceId = record.sourceDeviceId ?? existing.sourceDeviceId ?? null;
      existing.callsign = record.callsign.toUpperCase();
      existing.qth = record.qth;
      existing.timestamp = toDate(record.timestamp) || toDate(record.recordedAt) || existing.timestamp;
      existing.recordedAt = toDate(record.recordedAt) || toDate(record.timestamp) || existing.recordedAt;
      existing.clientUpdatedAt = record.clientUpdatedAt === undefined ? existing.clientUpdatedAt : toDate(record.clientUpdatedAt);
      existing.createdAt = toDate(record.createdAt) || existing.createdAt;
      existing.updatedAt = toDate(record.updatedAt) || new Date();
      existing.serverUpdatedAt = new Date();
      existing.deletedAt = record.deletedAt === undefined ? existing.deletedAt : toDate(record.deletedAt);
      await existing.save();
      return this._mapCallsignQth(existing.toObject());
    }

    const id = record.id || uuidv4();
    const created = await this.CallsignQthHistory.create({
      _id: id,
      userId,
      syncId: record.syncId ?? record.id ?? id,
      sourceDeviceId: record.sourceDeviceId ?? null,
      callsign: record.callsign.toUpperCase(),
      qth: record.qth,
      timestamp: toDate(record.timestamp) || toDate(record.recordedAt) || new Date(),
      recordedAt: toDate(record.recordedAt) || toDate(record.timestamp) || new Date(),
      clientUpdatedAt: toDate(record.clientUpdatedAt),
      serverUpdatedAt: new Date(),
      createdAt: toDate(record.createdAt) || new Date(),
      updatedAt: toDate(record.updatedAt) || new Date(),
      deletedAt: toDate(record.deletedAt),
    });
    return this._mapCallsignQth(created.toObject());
  }

  async softDeleteCallsignQth(id, deletedAt, userId) {
    const filter = { _id: id };
    if (userId) filter.userId = userId;

    const record = await this.CallsignQthHistory.findOneAndUpdate(filter, {
      deletedAt: toDate(deletedAt) || new Date(),
      updatedAt: toDate(deletedAt) || new Date(),
    }, { new: true }).lean();
    return record ? this._mapCallsignQth(record) : null;
  }

  _mapCallsignQth(doc) {
    return {
      id: doc._id.toString(),
      userId: doc.userId,
      syncId: doc.syncId ?? doc._id.toString(),
      sourceDeviceId: doc.sourceDeviceId ?? null,
      callsign: doc.callsign,
      qth: doc.qth,
      timestamp: doc.timestamp,
      recordedAt: doc.recordedAt ?? doc.timestamp,
      clientUpdatedAt: doc.clientUpdatedAt,
      serverUpdatedAt: doc.serverUpdatedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
    };
  }

  async findHistories(query = {}) {
    const filter = {};
    if (query.userId) filter.userId = query.userId;
    if (!query.includeDeleted) filter.deletedAt = null;
    const records = await this.History.find(filter).sort({ updatedAt: -1 }).lean();
    return records.map(doc => this._mapHistory(doc));
  }

  async findHistoryById(id) {
    const record = await this.History.findById(id).lean();
    return record ? this._mapHistory(record) : null;
  }

  async createHistory(data) {
    const id = data.id || uuidv4();
    const record = await this.History.create({
      _id: id,
      userId: data.userId,
      syncId: data.syncId ?? data.id ?? id,
      sourceDeviceId: data.sourceDeviceId ?? null,
      name: data.name,
      logsData: data.logsData,
      logCount: data.logCount ?? 0,
      clientUpdatedAt: toDate(data.clientUpdatedAt),
      serverUpdatedAt: new Date(),
      createdAt: toDate(data.createdAt) || new Date(),
      updatedAt: toDate(data.updatedAt) || toDate(data.createdAt) || new Date(),
      deletedAt: toDate(data.deletedAt),
    });
    return this._mapHistory(record.toObject());
  }

  async updateHistory(id, data) {
    const update = {};
    if (data.userId !== undefined) update.userId = data.userId;
    if (data.syncId !== undefined) update.syncId = data.syncId;
    if (data.sourceDeviceId !== undefined) update.sourceDeviceId = data.sourceDeviceId;
    if (data.name !== undefined) update.name = data.name;
    if (data.logsData !== undefined) update.logsData = data.logsData;
    if (data.logCount !== undefined) update.logCount = data.logCount;
    if (data.clientUpdatedAt !== undefined) update.clientUpdatedAt = toDate(data.clientUpdatedAt);
    if (data.serverUpdatedAt !== undefined) update.serverUpdatedAt = toDate(data.serverUpdatedAt);
    if (data.createdAt !== undefined) update.createdAt = toDate(data.createdAt);
    if (data.updatedAt !== undefined) update.updatedAt = toDate(data.updatedAt);
    if (data.deletedAt !== undefined) update.deletedAt = toDate(data.deletedAt);
    update.serverUpdatedAt = new Date();

    const record = await this.History.findByIdAndUpdate(id, update, { new: true }).lean();
    return record ? this._mapHistory(record) : null;
  }

  async deleteHistory(id) {
    const result = await this.History.findByIdAndDelete(id);
    return result !== null;
  }

  async findHistoriesSince(timestamp, userId) {
    const since = new Date(timestamp);
    const records = await this.History.find({
      userId,
      $or: [
        { updatedAt: { $gt: since } },
        { deletedAt: { $gt: since } },
      ],
    }).sort({ updatedAt: 1, deletedAt: 1 }).lean();
    return records.map(doc => this._mapHistory(doc));
  }

  async upsertHistorySync(data, userId) {
    const existing = data.id ? await this.findHistoryById(data.id) : null;

    if (existing) {
      const incomingUpdatedAt = latestTimestamp(data.updatedAt, data.deletedAt, data.createdAt);
      const existingUpdatedAt = latestTimestamp(existing.updatedAt, existing.deletedAt, existing.createdAt);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing;
      }

      return this.updateHistory(existing.id, { ...data, userId });
    }

    return this.createHistory({ ...data, userId });
  }

  async softDeleteHistory(id, deletedAt, userId) {
    const filter = { _id: id };
    if (userId) filter.userId = userId;

    const record = await this.History.findOneAndUpdate(filter, {
      deletedAt: toDate(deletedAt) || new Date(),
      updatedAt: toDate(deletedAt) || new Date(),
    }, { new: true }).lean();
    return record ? this._mapHistory(record) : null;
  }

  async findSessionById(sessionId) {
    const session = await this.Session.findOne({ session_id: sessionId }).lean();
    return session || null;
  }

  async findSessionsSince(timestamp, userId) {
    const since = new Date(timestamp);
    const filter = {
      $or: [
        { updated_at: { $gt: since } },
        { deleted_at: { $gt: since } },
      ],
    };
    if (userId) {
      filter.$or = [
        { updated_at: { $gt: since }, user_id: userId },
        { deleted_at: { $gt: since }, user_id: userId },
      ];
    }
    const sessions = await this.Session.find(filter)
      .sort({ updated_at: 1, deleted_at: 1 }).lean();
    return sessions;
  }

  async findSessionsByStatus(status, userId) {
    const filter = { status, deleted_at: null };
    if (userId) filter.user_id = userId;
    const sessions = await this.Session.find(filter).lean();
    return sessions;
  }

  async findSessions(userId) {
    const filter = { deleted_at: null };
    if (userId) filter.user_id = userId;
    const sessions = await this.Session.find(filter).lean();
    for (const session of sessions) {
      session.log_count = await this.Log.countDocuments({ sessionId: session.session_id, deletedAt: null });
    }
    return sessions;
  }

  async upsertSessionSync(data, userId) {
    const existing = await this.Session.findOne({ session_id: data.session_id });

    if (existing) {
      const incomingUpdatedAt = latestTimestamp(data.updated_at, data.deleted_at, data.created_at);
      const existingUpdatedAt = latestTimestamp(existing.updated_at, existing.deleted_at, existing.created_at);
      if (!isIncomingNewer(incomingUpdatedAt, existingUpdatedAt)) {
        return existing.toObject();
      }

      const updated = await this.Session.findOneAndUpdate(
        { session_id: data.session_id },
        {
          title: data.title,
          status: data.status ?? existing.status,
          created_at: toDate(data.created_at) || existing.created_at,
          updated_at: toDate(data.updated_at) || new Date(),
          closed_at: toDate(data.closed_at) ?? existing.closed_at,
          deleted_at: toDate(data.deleted_at) ?? existing.deleted_at,
          source_device_id: data.source_device_id ?? existing.source_device_id,
          user_id: userId,
        },
        { new: true }
      ).lean();
      return updated;
    }

    const session = await this.Session.create({
      session_id: data.session_id,
      title: data.title,
      status: data.status ?? 'active',
      created_at: toDate(data.created_at) || new Date(),
      updated_at: toDate(data.updated_at) || toDate(data.created_at) || new Date(),
      closed_at: toDate(data.closed_at),
      deleted_at: toDate(data.deleted_at),
      source_device_id: data.source_device_id ?? null,
      user_id: userId,
    });
    return session.toObject();
  }

  async softDeleteSession(sessionId, deletedAt, userId) {
    const filter = { session_id: sessionId };
    if (userId) filter.user_id = userId;

    await this.Session.findOneAndUpdate(filter, {
      deleted_at: toDate(deletedAt) || new Date(),
      updated_at: toDate(deletedAt) || new Date(),
    });
  }

  async findPublicLinkByShareCode(code) {
    return this.PublicLink.findOne({ share_code: code, enabled: 1, revoked_at: null }).lean();
  }

  async findPublicLinkBySession(sessionId, userId) {
    return this.PublicLink.findOne({ session_id: sessionId, user_id: userId, revoked_at: null }).lean();
  }

  async upsertPublicLink(data) {
    const existing = await this.PublicLink.findOne({ session_id: data.session_id, user_id: data.user_id, revoked_at: null });
    if (existing) {
      return this.PublicLink.findOneAndUpdate(
        { _id: existing._id },
        { share_code: data.share_code, enabled: data.enabled ?? 1, expires_at: data.expires_at || null, updated_at: new Date() },
        { new: true }
      ).lean();
    }
    return this.PublicLink.create({
      session_id: data.session_id, user_id: data.user_id, share_code: data.share_code,
      enabled: data.enabled ?? 1, created_at: data.created_at || new Date(),
      updated_at: new Date(), expires_at: data.expires_at || null,
    });
  }

  async revokePublicLink(sessionId, userId) {
    await this.PublicLink.updateOne(
      { session_id: sessionId, user_id: userId, revoked_at: null },
      { revoked_at: new Date(), updated_at: new Date() }
    );
  }

  async insertChangeLog(entry) {
    const last = await this.ChangeLog.findOne({}).sort({ change_id: -1 });
    entry.change_id = (last?.change_id || 0) + 1;
    return this.ChangeLog.create(entry);
  }

  async getChangesSince(sessionId, sinceChangeId) {
    return this.ChangeLog.find({ session_id: sessionId, change_id: { $gt: sinceChangeId } }).sort({ change_id: 1 }).lean();
  }

  _mapHistory(doc) {
    return {
      id: doc._id.toString(),
      userId: doc.userId,
      syncId: doc.syncId ?? doc._id.toString(),
      sourceDeviceId: doc.sourceDeviceId ?? null,
      name: doc.name,
      logsData: doc.logsData,
      logCount: doc.logCount,
      clientUpdatedAt: doc.clientUpdatedAt,
      serverUpdatedAt: doc.serverUpdatedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
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
