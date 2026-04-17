# OpenLogToolServer

OpenLogTool 服务端适配项目 - 提供数据同步能力和 Web 管理界面。

## 功能特性

- 🗄️ **数据库兼容** - 支持 MySQL 和 MongoDB，通过抽象层无缝切换
- 🔄 **三种同步模式**
  - Push 同步：移动端主动上传数据
  - Pull 同步：移动端拉取服务器增量数据
  - Bidirectional 双向同步：自动合并冲突
- 🎛️ **Web 后台管理** - React + Ant Design Pro 管理界面
- 🔐 **认证授权** - JWT Token 认证

## 项目结构

```
OpenLogToolServer/
├── src/
│   ├── database/         # 数据库抽象层
│   ├── models/           # 数据模型
│   ├── api/              # API 路由
│   ├── services/         # 业务逻辑
│   └── utils/            # 工具函数
├── server/               # 服务入口
├── web/                  # Web UI
├── package.json
└── SPEC.md
```

## 快速开始

### 1. 安装依赖

```bash
npm install
cd web && npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 配置数据库和 JWT
```

### 3. 启动服务

```bash
# 开发模式
npm run dev

# 生产模式
npm run build:web
npm start
```

## API 文档

### 基础路径

`/api/v1`

### 认证接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /auth/login | 管理员登录 |
| POST | /auth/refresh | 刷新 Token |

### 日志接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /logs | 获取日志列表 |
| POST | /logs/sync/push | Push 同步 |
| GET | /logs/sync/pull | Pull 同步 |

### 词典接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /dictionaries/:type | 获取词典 |
| POST | /dictionaries | 创建词典条目 |

## 同步机制详解

### Push 同步
移动端将本地数据批量上传到服务器，使用 upsert 策略（存在则更新，不存在则插入）。

### Pull 同步
移动端请求指定时间戳之后的增量数据，适用于多设备同步场景。

### Bidirectional 双向同步
先 Pull 获取服务器最新数据，再 Push 上传本地数据。冲突处理以 `updatedAt` 为准。

## 数据库配置

### MongoDB
```env
DB_TYPE=mongodb
DB_HOST=localhost
DB_PORT=27017
DB_NAME=openlogtool
```

### MySQL
```env
DB_TYPE=mysql
DB_HOST=localhost
DB_PORT=3306
DB_NAME=openlogtool
DB_USER=root
DB_PASSWORD=your_password
```

## License

AGPL-3.0
