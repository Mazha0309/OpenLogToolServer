# OpenLogTool 服务端重建设计

> **归档文档（2026-07-09）**：本文记录早期重建方向，不是当前 API 合同。
> 其中未版本化路由、永久 JWT、首位注册者自动成为管理员等内容均已废弃。
> 当前行为以仓库根目录 `README.md`、`docs/*-api-v1.md` 和
> `2026-07-11-collaboration-v1-design.md` 为准。

## 目标
将现有 Node.js 服务端（OpenLogToolServer）完全重写为 TypeScript + Express，简化功能：用户认证、session 持久化、liveshare 实时协作。

## 背景
- 旧服务端功能过于复杂（双向同步、Oplog、public links、admin 面板等），大部分已不再使用。
- 新方向：不搞双向同步，只做**协作记录共享**。
- 主项目（Flutter + Rust）的数据层已基本稳定，需要配套一个轻量服务端。

## 约束
- 使用 TypeScript + Node.js，与旧项目同语言更方便迭代。
- 数据库使用 SQLite（better-sqlite3），无需外部数据库依赖。
- JWT 认证，Token 不设过期（客户端保存即可）。
- 服务端同时 serve 前端 WebUI（React 管理后台）和 API。

## 技术栈
| 层 | 技术 |
|---|---|
| 后端 | Node.js + TypeScript + Express |
| 数据库 | better-sqlite3 |
| 认证 | jsonwebtoken (JWT) + bcryptjs |
| 实时 | ws (WebSocket) |
| 前端 | React 18 + Vite + Ant Design |

## 数据表

### users
| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | UUID |
| username | TEXT | UNIQUE NOT NULL | |
| password_hash | TEXT | NOT NULL | bcrypt |
| role | TEXT | NOT NULL DEFAULT 'user' | 'admin' / 'user'；首个用户自动 admin |
| created_at | TEXT | NOT NULL | ISO 8601 |
| updated_at | TEXT | NOT NULL | |

### server_settings（单行）
| 列 | 类型 | 说明 |
|---|---|---|
| registration_enabled | INTEGER | 0/1，默认 1 |

### sessions
| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | 客户端的 session_id |
| title | TEXT | NOT NULL | |
| status | TEXT | NOT NULL DEFAULT 'active' | 'active' / 'closed' |
| owner_user_id | TEXT | FK → users(id) | |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |
| deleted_at | TEXT | NULLABLE | 软删除 |

### logs
| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| sync_id | TEXT | NOT NULL | 客户端的 sync_id |
| session_id | TEXT | NOT NULL FK → sessions(id) | |
| controller | TEXT | NOT NULL | |
| callsign | TEXT | NOT NULL | |
| time | TEXT | NOT NULL | |
| rst_sent | TEXT | | |
| rst_rcvd | TEXT | | |
| qth | TEXT | | |
| device | TEXT | | |
| power | TEXT | | |
| antenna | TEXT | | |
| height | TEXT | | |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |
| deleted_at | TEXT | NULLABLE | |

## API 路由

```
POST /api/auth/register       { username, password } → { token, user }
POST /api/auth/login          { username, password } → { token, user }
GET  /api/auth/me             → { id, username, role }

GET  /api/sessions                     → session 列表（不含 deleted）
POST /api/sessions            body: { session_id, title, status }
GET  /api/sessions/:id                 → { session, logs }
PUT  /api/sessions/:id        body: { title?, status? }
DELETE /api/sessions/:id               → 软删除

GET  /api/sessions/:id/logs                → logs 列表
POST /api/sessions/:id/logs        body: { sync_id, ...fields }
PUT  /api/sessions/:id/logs/:syncId  body: { ...fields }
DELETE /api/sessions/:id/logs/:syncId

GET  /api/admin/settings           → { registration_enabled }
PUT  /api/admin/settings  body: { registration_enabled }
GET  /api/admin/users              → user 列表（不含密码）
```

## WebSocket Liveshare（Web 页面实时展示）
- 服务器提供 WebSocket 服务：`ws://server/ws?sessionId=xxx`
- Flutter 客户端做增删改时，REST API 层通过 `broadcast(sessionId, event)` 广播：
  ```
  { type: 'log.upsert', session, log }
  { type: 'log.delete', session, syncId }
  ```
- 浏览器打开 `https://server/live/<sessionId>` 进入 liveshare 页面：
  - 页面通过 WebSocket 连接该 session，实时显示日志表格。
  - 只读，没有编辑功能。
  - 不需要登录（或者可选密码保护）。
- 实现参考旧版 `WsManager` 但重新写，不要复制旧代码。

## 目录结构
```
OpenLogToolServer/
├── src/
│   ├── index.ts              # 入口，创建 Express app + WebSocket 服务器
│   ├── config.ts             # 加载 .env 配置
│   ├── db/
│   │   ├── database.ts       # SQLite 初始化 + 迁移
│   │   └── schema.sql        # DDL
│   ├── api/
│   │   ├── auth.ts           # register / login / me
│   │   ├── sessions.ts       # CRUD sessions
│   │   ├── logs.ts           # CRUD logs
│   │   └── admin.ts          # admin settings + users
│   ├── middleware/
│   │   ├── auth.ts           # JWT 验证中间件
│   │   └── admin.ts          # admin 角色检查
│   └── ws/
│       └── index.ts          # WebSocket 连接管理 + 广播
├── web/                      # Vite + React 管理后台
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── Dashboard.tsx       # 会话列表 + 概览
│   │   │   └── Admin.tsx           # 开关注册 + 用户管理
│   │   ├── api.ts                  # axios 实例 + 拦截器
│   │   └── main.tsx
│   └── index.html
├── .env
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Flutter 客户端改动（后续 plan）
- 设置页简化：只保留**服务器地址** + **登录/注册**按钮（去掉同步策略/间隔等选项）。
- 添加"上传到服务器"功能：把当前 session（包括 logs）提交到 `/api/sessions`。
- 添加"从服务器下载"功能：列出服务器上的 sessions，选中后下载并切换到该 session。
- Liveshare：Flutter 端**只负责常规 REST API 操作**，不需要连接 WebSocket。
- `SyncProvider` 不再需要，可移除。

## 实施顺序
1. TypeScript 后端骨架（Express + SQLite + 迁移 + 用户认证）
2. Sessions & Logs CRUD API
3. WebSocket liveshare
4. React 管理后台（登录 + Dashboard + Admin 设置）
5. 修改 Flutter 客户端（简化设置 + 上传/下载/liveshare）

## 测试计划
- 后端：可用 Postman/curl 测试，或写简单的 jest 测试。
- 前端：手动点击验证。
- Flutter：后续 Integration Test 覆盖 liveshare 场景。

## 兼容性
- 与旧数据库格式不兼容，全新开始。
- 旧代码保留在 `refactor/old` 分支，不删除。
