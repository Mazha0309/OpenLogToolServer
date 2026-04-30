/**
 * Session model
 * Represents a session with status tracking for OpenLogToolServer.
 */
import { createHash } from 'crypto';

export const SESSION_STATUS = {
  ACTIVE: 'active',
  CLOSED: 'closed',
  ARCHIVED: 'archived',
};

export class Session {
  /**
   * @param {Object} data
   * @param {string} data.session_id
   * @param {string} data.title
   * @param {string} [data.status]
   * @param {string|Date} [data.created_at]
   * @param {string|Date} [data.updated_at]
   * @param {string|Date} [data.closed_at]
   * @param {string|Date} [data.deleted_at]
   * @param {string} [data.source_device_id]
   */
  constructor(data = {}) {
    this.session_id = data.session_id;
    this.title = data.title;
    this.status = data.status || SESSION_STATUS.ACTIVE;
    this.created_at = data.created_at ? new Date(data.created_at) : new Date();
    this.updated_at = data.updated_at ? new Date(data.updated_at) : new Date(this.created_at);
    this.closed_at = data.closed_at ? new Date(data.closed_at) : null;
    this.deleted_at = data.deleted_at ? new Date(data.deleted_at) : null;
    this.source_device_id = data.source_device_id || null;

    this._validate();
  }

  _validate() {
    if (!this.session_id || typeof this.session_id !== 'string') {
      throw new Error('Session.session_id is required and must be a non-empty string');
    }
    if (!this.title || typeof this.title !== 'string') {
      throw new Error('Session.title is required and must be a non-empty string');
    }
    if (!Object.values(SESSION_STATUS).includes(this.status)) {
      throw new Error('Session.status must be one of: active, closed, archived');
    }
  }

  toJSON() {
    return {
      session_id: this.session_id,
      title: this.title,
      status: this.status,
      created_at: this.created_at instanceof Date ? this.created_at.toISOString() : this.created_at,
      updated_at: this.updated_at instanceof Date ? this.updated_at.toISOString() : this.updated_at,
      closed_at: this.closed_at instanceof Date ? this.closed_at.toISOString() : this.closed_at,
      deleted_at: this.deleted_at instanceof Date ? this.deleted_at.toISOString() : this.deleted_at,
      source_device_id: this.source_device_id,
    };
  }

  toMap() {
    return this.toJSON();
  }

  static fromJSON(obj) {
    if (!obj) return null;
    return new Session(obj);
  }

  static fromMap(map) {
    if (!map) return null;
    return new Session(map);
  }

  static generateSessionId(clientInstanceId = 'server') {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2, 10);
    const raw = `${clientInstanceId}:${timestamp}:${random}`;
    return createHash('sha256').update(raw).digest('hex').substring(0, 32);
  }

  static migrationSessionId(historySyncId) {
    const raw = `history-migration:${historySyncId}`;
    return createHash('sha256').update(raw).digest('hex').substring(0, 32);
  }
}

export default Session;