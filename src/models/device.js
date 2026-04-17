/**
 * Device model
 * Represents a registered device with last sync time and status.
 */
export const DEVICE_STATUS = {
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE',
  SYNCING: 'SYNCING',
};

export class Device {
  /**
   * @param {Object} data
   * @param {string} data.deviceId
   * @param {string} [data.name]
   * @param {string} [data.model]
   * @param {string|Date} [data.lastSyncTime]
   * @param {string|Date} [data.registrationTime]
   * @param {string} [data.status]
   */
  constructor(data = {}) {
    this.deviceId = data.deviceId;
    this.name = data.name;
    this.model = data.model;
    this.lastSyncTime = data.lastSyncTime ? new Date(data.lastSyncTime) : undefined;
    this.registrationTime = data.registrationTime ? new Date(data.registrationTime) : new Date();
    this.status = data.status || DEVICE_STATUS.OFFLINE;

    this._validate();
  }

  _validate() {
    if (typeof this.deviceId !== 'string' || this.deviceId.trim() === '') {
      throw new Error('Device.deviceId is required and must be a non-empty string');
    }
    if (this.status && !Object.values(DEVICE_STATUS).includes(this.status)) {
      throw new Error('Device.status must be a valid DEVICE_STATUS value');
    }
    // times: if provided, must be valid Date objects
    if (this.lastSyncTime && isNaN(this.lastSyncTime)) {
      throw new Error('Device.lastSyncTime must be a valid date');
    }
    if (this.registrationTime && isNaN(this.registrationTime)) {
      throw new Error('Device.registrationTime must be a valid date');
    }
  }

  toJSON() {
    return {
      deviceId: this.deviceId,
      name: this.name,
      model: this.model,
      lastSyncTime: this.lastSyncTime ? this.lastSyncTime.toISOString() : undefined,
      registrationTime: this.registrationTime ? this.registrationTime.toISOString() : undefined,
      status: this.status,
    };
  }

  toMap() {
    return this.toJSON();
  }

  static fromJSON(obj) {
    if (!obj) return null;
    return new Device({
      deviceId: obj.deviceId,
      name: obj.name,
      model: obj.model,
      lastSyncTime: obj.lastSyncTime,
      registrationTime: obj.registrationTime,
      status: obj.status,
    });
  }

  static fromMap(map) {
    if (!map) return null;
    return new Device({
      deviceId: map.deviceId,
      name: map.name,
      model: map.model,
      lastSyncTime: map.lastSyncTime,
      registrationTime: map.registrationTime,
      status: map.status,
    });
  }
}

export default Device;
