/**
 * Dictionary item model
 * Represents a key-value pair within a typed dictionary.
 */
export const DICTIONARY_TYPES = {
  SYSTEM: 'SYSTEM',
  CONFIG: 'CONFIG',
  ERROR_CODES: 'ERROR_CODES',
  MESSAGES: 'MESSAGES',
};

export class DictionaryItem {
  /**
   * @param {Object} data
   * @param {string} data.id
   * @param {string} data.type
   * @param {string} data.key
   * @param {string} data.value
   * @param {string} [data.description]
   */
  constructor(data = {}) {
    this.id = data.id;
    this.type = data.type;
    this.key = data.key;
    this.value = data.value;
    this.description = data.description;

    this._validate();
  }

  _validate() {
    // type is required and must be one of enum values
    if (!Object.values(DICTIONARY_TYPES).includes(this.type)) {
      throw new Error('DictionaryItem.type must be one of the defined dictionary types');
    }
    // key: required, max 64
    if (typeof this.key !== 'string' || this.key.trim() === '') {
      throw new Error('DictionaryItem.key is required and must be a non-empty string');
    }
    if (this.key.length > 64) {
      throw new Error('DictionaryItem.key must be at most 64 characters');
    }
    // value: required, max 256
    if (typeof this.value !== 'string' || this.value.trim() === '') {
      throw new Error('DictionaryItem.value is required and must be a non-empty string');
    }
    if (this.value.length > 256) {
      throw new Error('DictionaryItem.value must be at most 256 characters');
    }
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      key: this.key,
      value: this.value,
      description: this.description,
    };
  }

  toMap() {
    return this.toJSON();
  }

  static fromJSON(obj) {
    if (!obj) return null;
    return new DictionaryItem({
      id: obj.id,
      type: obj.type,
      key: obj.key,
      value: obj.value,
      description: obj.description,
    });
  }

  static fromMap(map) {
    if (!map) return null;
    return new DictionaryItem({
      id: map.id,
      type: map.type,
      key: map.key,
      value: map.value,
      description: map.description,
    });
  }
}

export default DictionaryItem;
