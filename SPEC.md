# OpenLogToolServer 架构设计

## 项目概述

OpenLogTool 的服务端适配项目，提供数据同步能力和 Web 管理界面。

## 技术选型

| 层级 | 技术 |
|------|------|
| 后端框架 | Node.js + Express / Fastify |
| 数据库 | MySQL / MongoDB（通过抽象层兼容） |
| Web UI | React + Ant Design Pro |
| 认证 | JWT |

## 数据模型

### LogEntry（日志条目）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (UUID) | 主键 |
| deviceId | string | 设备标识（用于区分来源） |
| time | datetime | 记录时间 |
| controller | string | 控制员 |
| callsign | string | 呼号 |
| report | string | 报告 |
| qth | string | 位置 |
| device | string | 设备 |
| power | string | 功率 |
| antenna | string | 天线 |
| height | string | 高度 |
| createdAt | datetime | 创建时间 |
| updatedAt | datetime | 更新时间 |

### DictionaryItem（词典条目）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (UUID) | 主键 |
| type | enum | device/antenna/qth/callsign |
| raw | string | 原始值 |
| pinyin | string | 拼音 |
| abbreviation | string | 缩写 |

## 同步机制

### 1. Push 同步（移动端 → 服务器）

- 移动端主动上传本地数据
- 支持批量上传
- 服务端使用 upsert（存在则更新，不存在则插入）
- 返回同步结果和新分配的 serverId 映射

### 2. Pull 同步（服务器 → 移动端）

- 移动端请求指定时间戳之后的增量数据
- 请求参数：`since` (datetime) 和 `deviceId`
- 返回增量数据列表

### 3. Bidirectional 双向同步

- 结合 Push 和 Pull
- 先 Pull 获取服务器最新数据
- 再 Push 上传本地新增数据
- 冲突处理策略：
  - 以 `updatedAt` 时间戳判断
  - 服务器数据较新：忽略本地
  - 本地数据较新：覆盖服务器
  - 可配置冲突处理策略

## API 设计

### 基础路径：`/api/v1`

#### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /auth/login | 管理员登录 |
| POST | /auth/refresh | 刷新 Token |

#### 日志管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /logs | 获取日志列表（分页、筛选） |
| GET | /logs/:id | 获取单个日志 |
| POST | /logs | 创建日志 |
| PUT | /logs/:id | 更新日志 |
| DELETE | /logs/:id | 删除日志 |
| POST | /logs/sync/push | Push 同步 |
| GET | /logs/sync/pull | Pull 同步 |

#### 词典管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /dictionaries | 获取词典列表 |
| GET | /dictionaries/:type | 获取指定类型词典 |
| POST | /dictionaries | 创建词典条目 |
| PUT | /dictionaries/:id | 更新词典条目 |
| DELETE | /dictionaries/:id | 删除词典条目 |

#### 管理后台

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /admin/stats | 获取统计数据 |
| GET | /admin/devices | 设备管理 |
| GET | /admin/sync-logs | 同步记录 |

## Web UI 功能

### 1. 登录页面
- 管理员认证
- JWT Token 管理

### 2. 主仪表板
- 总日志统计
- 今日/本周/本月数据
- 同步状态

### 3. 日志管理
- 日志列表（分页、筛选、搜索）
- 日志详情查看
- 日志编辑
- 批量操作

### 4. 词典管理
- 词典类型切换
- 条目增删改查
- 批量导入

### 5. 设备管理
- 注册设备列表
- 设备同步状态
- 设备数据概览

### 6. 系统设置
- 数据库配置
- 同步策略配置
- 用户管理

## 目录结构

```
OpenLogToolServer/
├── src/
│   ├── database/         # 数据库抽象层
│   │   ├── connector.js  # 数据库连接器
│   │   ├── adapters/     # MySQL/MongoDB 适配器
│   │   └── repository.js # 数据仓储基类
│   ├── models/           # 数据模型
│   ├── api/              # API 路由
│   ├── services/         # 业务逻辑
│   └── utils/            # 工具函数
├── server/               # 服务入口
│   └── index.js
├── web/                  # Web UI
│   ├── src/
│   └── package.json
├── package.json
└── SPEC.md
```

## 数据库适配器接口

```javascript
class DatabaseAdapter {
  async connect() {}
  async disconnect() {}

  // Logs
  async findLogs(query, pagination) {}
  async findLogById(id) {}
  async createLog(data) {}
  async updateLog(id, data) {}
  async deleteLog(id) {}
  async upsertLog(data, deviceId) {}

  // Dictionaries
  async findDictionaries(type, query) {}
  async createDictionary(type, data) {}
  async updateDictionary(id, data) {}
  async deleteDictionary(id) {}

  // Sync
  async findLogsSince(deviceId, timestamp) {}
}
```
