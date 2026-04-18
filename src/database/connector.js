import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getConfig } from '../config/index.js';
import { MemoryAdapter } from './adapters/memory.js';
import { MysqlAdapter } from './adapters/mysql.js';
import { MongodbAdapter } from './adapters/mongodb.js';

class DatabaseConnector {
  constructor() {
    this.adapter = null;
    this._config = null;
  }

  get config() {
    if (!this._config) {
      this._config = getConfig();
    }
    return this._config;
  }

  get dbType() {
    return this.config.DB_TYPE;
  }

  async connect() {
    if (this.adapter) return this.adapter;

    const cfg = this.config;
    switch (cfg.DB_TYPE) {
      case 'mysql':
        this.adapter = await this._connectMysql(cfg);
        break;
      case 'mongodb':
        this.adapter = await this._connectMongodb(cfg);
        break;
      default:
        this.adapter = new MemoryAdapter();
        await this.adapter.connect();
    }

    return this.adapter;
  }

  async _connectMysql(cfg) {
    const mysqlAdapter = new MysqlAdapter({
      host: cfg.DB_HOST,
      port: parseInt(cfg.DB_PORT || '3306'),
      user: cfg.DB_USER,
      password: cfg.DB_PASSWORD,
      database: cfg.DB_NAME,
    });
    await mysqlAdapter.connect();
    return mysqlAdapter;
  }

  async _connectMongodb(cfg) {
    const mongodbAdapter = new MongodbAdapter({
      host: cfg.DB_HOST,
      port: parseInt(cfg.DB_PORT || '27017'),
      database: cfg.DB_NAME,
      username: cfg.DB_USER,
      password: cfg.DB_PASSWORD,
    });
    await mongodbAdapter.connect();
    return mongodbAdapter;
  }

  async disconnect() {
    if (this.adapter && this.adapter.disconnect) {
      await this.adapter.disconnect();
    }
    this.adapter = null;
  }

  getAdapter() {
    return this.adapter;
  }

  getDbType() {
    return this.dbType;
  }

  reloadConfig() {
    this._config = getConfig();
  }
}

const connector = new DatabaseConnector();
export default connector;
export { DatabaseConnector };
