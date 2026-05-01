/**
 * PublicLink model
 * Represents a shareable link for live session viewing.
 */
import { v4 as uuidv4 } from 'uuid';

export class PublicLink {
  constructor(data = {}) {
    this.id = data.id || uuidv4();
    this.session_id = data.session_id;
    this.user_id = data.user_id;
    this.share_code = data.share_code || uuidv4().substring(0, 12);
    this.enabled = data.enabled !== undefined ? data.enabled : 1;
    this.created_at = data.created_at || new Date();
    this.updated_at = data.updated_at || new Date();
    this.expires_at = data.expires_at || null;
    this.revoked_at = data.revoked_at || null;
    this.view_options_json = data.view_options_json || '{}';
    if (data.session_id) this._validate();
  }

  _validate() {
    if (!this.session_id) throw new Error('PublicLink.session_id is required');
    if (!this.user_id) throw new Error('PublicLink.user_id is required');
    if (!this.share_code) throw new Error('PublicLink.share_code is required');
  }

  toJSON() {
    return {
      id: this.id,
      session_id: this.session_id,
      user_id: this.user_id,
      share_code: this.share_code,
      enabled: this.enabled,
      created_at: this.created_at instanceof Date ? this.created_at.toISOString() : this.created_at,
      updated_at: this.updated_at instanceof Date ? this.updated_at.toISOString() : this.updated_at,
      expires_at: this.expires_at instanceof Date ? this.expires_at.toISOString() : this.expires_at,
      revoked_at: this.revoked_at instanceof Date ? this.revoked_at.toISOString() : this.revoked_at,
      view_options_json: this.view_options_json,
    };
  }

  toMap() {
    return this.toJSON();
  }

  static fromJSON(obj) {
    return obj ? new PublicLink(obj) : null;
  }

  static fromMap(map) {
    return map ? new PublicLink(map) : null;
  }
}

/**
 * ChangeLog model
 * Represents a recorded change for live collaboration sync.
 */
export class ChangeLog {
  constructor(data = {}) {
    this.change_id = data.change_id;
    this.session_id = data.session_id;
    this.entity_type = data.entity_type;
    this.entity_sync_id = data.entity_sync_id;
    this.action = data.action;
    this.payload_json = data.payload_json;
    this.source_device_id = data.source_device_id || null;
    this.server_created_at = data.server_created_at || new Date();
    if (data.session_id) this._validate();
  }

  _validate() {
    if (!this.session_id) throw new Error('ChangeLog.session_id is required');
    if (!this.entity_type) throw new Error('ChangeLog.entity_type is required');
    if (!this.entity_sync_id) throw new Error('ChangeLog.entity_sync_id is required');
    if (!this.action) throw new Error('ChangeLog.action is required');
  }

  toJSON() {
    return {
      change_id: this.change_id,
      session_id: this.session_id,
      entity_type: this.entity_type,
      entity_sync_id: this.entity_sync_id,
      action: this.action,
      payload_json: this.payload_json,
      source_device_id: this.source_device_id,
      server_created_at: this.server_created_at instanceof Date ? this.server_created_at.toISOString() : this.server_created_at,
    };
  }

  toMap() {
    return this.toJSON();
  }

  static fromJSON(obj) {
    return obj ? new ChangeLog(obj) : null;
  }

  static fromMap(map) {
    return map ? new ChangeLog(map) : null;
  }
}

export default PublicLink;
