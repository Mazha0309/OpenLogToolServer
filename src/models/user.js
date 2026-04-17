/**
 * User model (admin/user accounts)
 * Supports parent-child account hierarchy
 */
import { v4 as uuidv4 } from 'uuid';

export const USER_ROLES = {
  ADMIN: 'admin',
  USER: 'user',
};

export const THEME_MODES = {
  LIGHT: 'light',
  DARK: 'dark',
};

export class User {
  /**
   * @param {Object} data
   * @param {string} [data.id]
   * @param {string} data.username
   * @param {string} data.passwordHash
   * @param {string} [data.role]
   * @param {string} [data.parentId]
   * @param {string} [data.theme]
   * @param {Date} [data.createdAt]
   * @param {Date} [data.updatedAt]
   */
  constructor(data = {}) {
    this.id = data.id || uuidv4();
    this.username = data.username;
    this.passwordHash = data.passwordHash;
    this.role = data.role || USER_ROLES.USER;
    this.parentId = data.parentId || null;
    this.theme = data.theme || THEME_MODES.LIGHT;
    this.createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
    this.updatedAt = data.updatedAt ? new Date(data.updatedAt) : new Date();

    if (data.username) this._validate();
  }

  _validate() {
    if (!this.username || this.username.trim() === '') {
      throw new Error('User.username is required');
    }
    if (!this.passwordHash || this.passwordHash.trim() === '') {
      throw new Error('User.passwordHash is required');
    }
  }

  isAdmin() {
    return this.role === USER_ROLES.ADMIN;
  }

  isChildAccount() {
    return this.parentId !== null;
  }

  toJSON() {
    return {
      id: this.id,
      username: this.username,
      passwordHash: this.passwordHash,
      role: this.role,
      parentId: this.parentId,
      theme: this.theme,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  toSafeJSON() {
    return {
      id: this.id,
      username: this.username,
      role: this.role,
      parentId: this.parentId,
      theme: this.theme,
      createdAt: this.createdAt.toISOString(),
    };
  }

  static fromJSON(obj) {
    if (!obj) return null;
    return new User({
      id: obj.id,
      username: obj.username,
      passwordHash: obj.passwordHash,
      role: obj.role || USER_ROLES.USER,
      parentId: obj.parentId || null,
      theme: obj.theme || THEME_MODES.LIGHT,
      createdAt: obj.createdAt,
      updatedAt: obj.updatedAt,
    });
  }
}

export class Share {
  /**
   * Share model for cross-account data sharing
   */
  constructor(data = {}) {
    this.id = data.id || uuidv4();
    this.fromUserId = data.fromUserId;
    this.toUserId = data.toUserId;
    this.shareType = data.shareType; // 'logs' | 'dictionaries' | 'both'
    this.status = data.status || 'pending'; // 'pending' | 'accepted' | 'rejected'
    this.data = data.data || null;
    this.createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
  }

  toJSON() {
    return {
      id: this.id,
      fromUserId: this.fromUserId,
      toUserId: this.toUserId,
      shareType: this.shareType,
      status: this.status,
      data: this.data,
      createdAt: this.createdAt.toISOString(),
    };
  }

  static fromJSON(obj) {
    if (!obj) return null;
    return new Share({
      id: obj.id,
      fromUserId: obj.fromUserId,
      toUserId: obj.toUserId,
      shareType: obj.shareType,
      status: obj.status,
      data: obj.data,
      createdAt: obj.createdAt,
    });
  }
}

export default User;
