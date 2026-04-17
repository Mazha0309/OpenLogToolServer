import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import { MemoryAdapter } from './adapters/memory.js';
import { MysqlAdapter } from './adapters/mysql.js';
import { MongodbAdapter } from './adapters/mongodb.js';

dotenv.config();

class DatabaseConnector {
  constructor() {
    this.adapter = null;
    this.dbType = process.env.DB_TYPE || 'memory';
  }

  async connect() {
    if (this.adapter) return this.adapter;

    switch (this.dbType) {
      case 'mysql':
        this.adapter = await this._connectMysql();
        break;
      case 'mongodb':
        this.adapter = await this._connectMongodb();
        break;
      default:
        this.adapter = new MemoryAdapter();
        await this.adapter.connect();
    }

    return this.adapter;
  }

  async _connectMysql() {
    const mysqlAdapter = new MysqlAdapter({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'openlogtool',
    });
    await mysqlAdapter.connect();
    return mysqlAdapter;
  }

  async _connectMongodb() {
    const mongodbAdapter = new MongodbAdapter({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '27017'),
      database: process.env.DB_NAME || 'openlogtool',
      username: process.env.DB_USER || '',
      password: process.env.DB_PASSWORD || '',
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
}

const connector = new DatabaseConnector();
export default connector;
export { DatabaseConnector };
