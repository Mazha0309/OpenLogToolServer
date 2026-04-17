/**
 * LogEntry model
 * Represents a log entry captured by the OpenLogToolServer.
 * Includes validation, serialization, and factory helpers.
 */
export class LogEntry {
  /**
   * @param {Object} data
   * @param {string|number} [data.id]
   * @param {string} data.controller
   * @param {string} data.callsign
   * @param {Date|string|number} data.time
   * @param {string} [data.message]
   * @param {string} [data.level]
   */
  constructor(data = {}) {
    this.id = data.id;
    this.controller = data.controller;
    this.callsign = data.callsign;
    this.time = data.time ? new Date(data.time) : undefined;
    this.message = data.message;
    this.level = data.level;

    this._validate();
  }

  /** Validation rules */
  _validate() {
    // controller: required, max 100
    if (typeof this.controller !== 'string' || this.controller.trim() === '') {
      throw new Error('LogEntry.controller is required and must be a non-empty string');
    }
    if (this.controller.length > 100) {
      throw new Error('LogEntry.controller must be at most 100 characters');
    }
    // callsign: required, max 20
    if (typeof this.callsign !== 'string' || this.callsign.trim() === '') {
      throw new Error('LogEntry.callsign is required and must be a non-empty string');
    }
    if (this.callsign.length > 20) {
      throw new Error('LogEntry.callsign must be at most 20 characters');
    }
    // time: required and valid date
    if (!(this.time instanceof Date) || isNaN(this.time)) {
      throw new Error('LogEntry.time is required and must be a valid date');
    }
  }

  toJSON() {
    return {
      id: this.id,
      controller: this.controller,
      callsign: this.callsign,
      time: this.time.toISOString(),
      message: this.message,
      level: this.level,
    };
  }

  toMap() {
    return {
      id: this.id,
      controller: this.controller,
      callsign: this.callsign,
      time: this.time.toISOString(),
      message: this.message,
      level: this.level,
    };
  }

  /** Factory helpers */
  static fromJSON(obj) {
    if (!obj) return null;
    return new LogEntry({
      id: obj.id,
      controller: obj.controller,
      callsign: obj.callsign,
      time: obj.time,
      message: obj.message,
      level: obj.level,
    });
  }

  static fromMap(map) {
    if (!map) return null;
    return new LogEntry({
      id: map.id,
      controller: map.controller,
      callsign: map.callsign,
      time: map.time,
      message: map.message,
      level: map.level,
    });
  }
}

export default LogEntry;
