# OpenLogTool Server

OpenLogTool 配套服务端，提供用户认证、Session 持久化、Liveshare 实时展示。

## 技术栈

- TypeScript + Node.js + Express
- SQLite (better-sqlite3)
- WebSocket (ws)
- React 18 + Ant Design (管理后台)
- Docker

## 快速启动

### 方式一：Docker（推荐）

```bash
git clone -b rewrite https://github.com/Mazha0309/OpenLogToolServer.git
cd OpenLogToolServer
echo 'JWT_SECRET=你的随机密钥' > .env
docker compose up -d
```

服务端运行在 `http://0.0.0.0:3000`。

### 方式二：直接 Node

```bash
git clone -b rewrite https://github.com/Mazha0309/OpenLogToolServer.git
cd OpenLogToolServer
npm install
echo 'JWT_SECRET=你的随机密钥' > .env
npm run build
npm run start
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册（需管理员开放注册） |
| POST | `/api/auth/login` | 登录 |
| GET | `/api/auth/me` | 当前用户信息 |
| GET | `/api/sessions` | 列出我的 sessions |
| POST | `/api/sessions` | 创建 session |
| GET | `/api/sessions/:id` | 获取 session + logs |
| PUT | `/api/sessions/:id` | 更新 session |
| DELETE | `/api/sessions/:id` | 删除 session |
| GET | `/api/sessions/:id/logs` | 列出 logs |
| POST | `/api/sessions/:id/logs` | 创建 log |
| PUT | `/api/sessions/:id/logs/:syncId` | 更新 log |
| DELETE | `/api/sessions/:id/logs/:syncId` | 删除 log |
| GET | `/api/admin/settings` | 服务器设置（admin） |
| PUT | `/api/admin/settings` | 更新设置（admin） |
| GET | `/api/admin/users` | 用户列表（admin） |

## WebSocket

- `ws://host:3000/ws?sessionId=xxx`
- 连接时需指定 sessionId
- 增删改日志时自动广播 `log.upsert` / `log.delete` 事件

## 页面

- 管理后台：`/admin`（需登录，admin 可管理用户和注册开关）
- Liveshare：`/live/<sessionId>`（实时展示日志，无需登录）

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `JWT_SECRET` | `change-me-to-a-random-string` | JWT 签名密钥 |
| `DB_PATH` | `./data/openlogtool.db` | 数据库文件路径 |
