/**
 * Synchronization record model
 * Logs details of each sync operation between devices and server.
 */
export const SYNC_DIRECTIONS = {
  TO_SERVER: 'TO_SERVER',
  FROM_SERVER: 'FROM_SERVER',
};

export class SyncRecord {
  /**
   * @param {Object} data
   * @param {string} data.id
   * @param {string} data.deviceId
   * @param {string} data.direction
   * @param {Date|string|number} data.timestamp
   * @param {string} [data.details]
   */
  constructor(data = {}) {
    this.id = data.id;
    this.deviceId = data.deviceId;
    this.direction = data.direction;
    this.timestamp = data.timestamp ? new Date(data.timestamp) : new Date();
    this.details = data.details;

    this._validate();
  }

  _validate() {
    if (!this.deviceId || typeof this.deviceId !== 'string') {
      throw new Error('SyncRecord.deviceId is required and must be a string');
    }
    if (!Object.values(SYNC_DIRECTIONS).includes(this.direction)) {
      throw new Error('SyncRecord.direction must be TO_SERVER or FROM_SERVER');
    }
    if (!(this.timestamp instanceof Date) || isNaN(this.timestamp)) {
      throw new Error('SyncRecord.timestamp must be a valid date');
    }
  }

  toJSON() {
    return {
      id: this.id,
      deviceId: this.deviceId,
      direction: this.direction,
      timestamp: this.timestamp.toISOString(),
      details: this.details,
    };
  }

  toMap() {
    return this.toJSON();
  }

  static fromJSON(obj) {
    if (!obj) return null;
    return new SyncRecord({
      id: obj.id,
      deviceId: obj.deviceId,
      direction: obj.direction,
      timestamp: obj.timestamp,
      details: obj.details,
    });
  }

  static fromMap(map) {
    if (!map) return null;
    return new SyncRecord({
      id: map.id,
      deviceId: map.deviceId,
      direction: map.direction,
      timestamp: map.timestamp,
      details: map.details,
    });
  }
}

export default SyncRecord;
