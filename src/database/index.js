/**
 * @fileoverview 数据库模块导出
 */

import connector from './connector.js';
import { LogRepository, DictionaryRepository, DeviceRepository, UserRepository, SyncRecordRepository } from './repository.js';

export { connector, LogRepository, DictionaryRepository, DeviceRepository, UserRepository, SyncRecordRepository };
export default connector;
