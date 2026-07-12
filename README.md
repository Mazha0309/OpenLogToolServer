# OpenLogTool Server

OpenLogTool 配套服务端，提供用户认证、Session/日志持久化、管理后台，以及协作 v1 的发布、成员和实时事件协议。

完整协作协议见 [Session 协作 v1 设计](docs/superpowers/specs/2026-07-11-collaboration-v1-design.md)。

## 技术栈

- TypeScript + Node.js 20 + Express
- SQLite（better-sqlite3）
- WebSocket（ws）
- React 19 + Ant Design 6
- Docker

## 环境要求

- Node.js 20.19 或更高版本
- npm 10 或更高版本

## 配置

复制 `.env.example` 并设置独立随机密钥：

~~~bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 24
~~~

把两个输出分别填入：

~~~dotenv
JWT_SECRET=<至少 32 字节的随机值>
ADMIN_BOOTSTRAP_TOKEN=<至少 24 字节的随机值>
INVITE_HMAC_KEY=<至少 32 字节的独立随机值>
~~~

生产启动不再接受默认 JWT 密钥。空数据库首次启动时也必须配置管理员初始化 token。

## 启动

### Docker

~~~bash
docker compose up -d --build
~~~

服务默认监听 `http://0.0.0.0:3000`，SQLite 位于 `./data/openlogtool.db`。

### 直接运行

~~~bash
npm ci

(cd web && npm ci && npm run build)
(cd live && npm ci && npm run build)

npm run verify
npm start
~~~

开发模式：

~~~bash
npm run dev
~~~

## 首个管理员

不再由“第一个公网注册者”自动成为管理员。空数据库初始化时调用：

~~~bash
curl -X POST http://127.0.0.1:3000/api/v1/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -H 'X-Bootstrap-Secret: <ADMIN_BOOTSTRAP_TOKEN>' \
  -d '{"username":"admin","password":"replace-with-a-strong-password"}'
~~~

初始化只能成功一次。之后是否允许普通用户注册由管理后台的注册开关决定。

## API v1 基础

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/server-info` | 服务端实例 ID、协议范围和已启用能力 |
| POST | `/api/v1/auth/bootstrap` | 初始化第一个管理员 |
| POST | `/api/v1/auth/register` | 注册普通用户 |
| POST | `/api/v1/auth/login` | 登录并取得 access/refresh token |
| POST | `/api/v1/auth/refresh` | 轮换 refresh token |
| POST | `/api/v1/auth/logout` | 撤销 refresh token |
| GET | `/api/v1/auth/me` | 当前用户 |
| GET | `/api/v1/admin/overview` | 管理员读取服务器与用户、Session 的非识别聚合概览 |
| GET/PATCH | `/api/v1/admin/settings` | 管理员读取或更新普通用户注册开关 |
| GET | `/api/v1/admin/users?q=&role=&page=&pageSize=` | 管理员分页搜索账户 |
| GET/PUT | `/api/v1/sessions`、`/api/v1/sessions/:id` | 成员 Session 列表与幂等发布初始化 |
| POST | `/api/v1/sessions/:id/bootstrap/logs` | 分批写入发布快照（最多 500 条/批） |
| POST | `/api/v1/sessions/:id/activate` | 校验记录数并激活 Session |
| GET | `/api/v1/sessions/:id/snapshot` | 一致性完整快照 |
| GET | `/api/v1/sessions/:id/membership` | 当前成员权限 |
| GET/PATCH/DELETE | `/api/v1/sessions/:id/members...` | Owner 成员管理 |
| POST | `/api/v1/sessions/:id/transfer-ownership` | 事务性转移所有权 |
| GET/POST/DELETE | `/api/v1/sessions/:id/invites...` | Owner 邀请管理 |
| POST | `/api/v1/collaboration-invites/redeem` | 原子、幂等兑换邀请码 |
| POST | `/api/v1/sessions/:id/mutations` | 批量提交独立原子的 Log/Session mutation |
| GET | `/api/v1/sessions/:id/events?afterSeq=N` | 按连续 Session seq 补拉规范事件 |
| POST | `/api/v1/sessions/:id/ws-ticket` | 创建 60 秒、单次使用的鉴权 WebSocket ticket |

实时连接使用 `/ws/collaboration?ticket=...`。服务端先发送 `hello`，连续投递 ticket cursor 之后的 backlog，再发送 `ready` 并进入 live；业务写入始终走 REST。每个 accepted mutation 的 REST event、`events` 补拉对象、数据库事件和 WebSocket event 是同一个规范对象。ticket 会绑定签发时的成员角色和版本，权限变化后的旧 ticket 不能消费；WS backlog 超过 1000 条时客户端必须先用 REST 补拉，慢消费者缓冲超过 8 MiB 会被要求重新同步。

Mutation 单批最多 100 个操作和 1 MiB。每个操作使用独立 UUID `mutationId`，重试必须复用；服务端把首次 accepted/conflict/rejected 结果持久化。Log 支持 create/update/delete/restore，Session Owner 支持 title update/close/reopen，全部使用严格 `baseVersion`。

Access token 默认 15 分钟有效，refresh token 默认 30 天有效并在刷新时轮换。

v1 管理接口只授予服务器 control-plane 权限：聚合概览不返回 Session ID、标题、Owner、成员关系或 Log 内容，账户列表也不返回用户与 Session 的关联。全局 `admin` 不会因此获得 collaboration data-plane 权限；未成为成员时，访问 Session 快照、事件或 mutation 仍按对象级 membership 规则拒绝。

旧 `/api/auth` 与 `/api/admin` 仅供现有管理后台过渡使用。旧 `/api/sessions`、日志写入、`/api/shares`、Liveshare 与无鉴权 `/ws` 均不再挂载；迁移 v6 会统一撤销历史 `shares`，防止绕过 v1 成员权限、幂等与副本序列。

## 页面

- 管理后台：`/admin/`
带快照、公开 capability 和鉴权事件流的新 Liveshare 将在协作 v1 后续阶段接入；在此之前不暴露旧页面或 WebSocket。

## 数据库迁移

迁移作为 TypeScript 模块编译进 `dist`，启动时按版本和 checksum 顺序执行，不依赖运行时复制 `schema.sql`。

基础迁移会：

- 创建稳定 `serverInstanceId`；
- 创建 refresh token 和迁移审计表；
- 增加 Session/Log 的版本基础字段；
- 无损处理旧库重复 Log；
- 建立 `UNIQUE(session_id, sync_id)`；
- 创建成员、邀请、兑换与持久幂等表，并回填旧 Session Owner；
- 创建连续 `session_events` 和仅存 hash 的单次 `ws_tickets`（迁移 v8）；
- 将邀请码 HMAC 密钥指纹绑定到服务器数据库，阻止静默错换密钥；
- 启用 WAL、外键和 5 秒 busy timeout。

修改生产数据库前应备份 `data/openlogtool.db`。

## 验证命令

~~~bash
npm run typecheck
npm test
npm run test:dist
npm run verify
~~~

`test:dist` 会使用正式编译产物在临时目录创建数据库，验证迁移表、关键列、唯一索引、外键和 WAL。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `DB_PATH` | `./data/openlogtool.db` | SQLite 路径 |
| `JWT_SECRET` | 无 | 必填，至少 32 字节 |
| `ADMIN_BOOTSTRAP_TOKEN` | 无 | 空库必填，至少 24 字节 |
| `INVITE_HMAC_KEY` | 无 | 必填，至少 32 字节；不得复用 JWT 密钥 |
| `JWT_ISSUER` | `openlogtool-server` | JWT issuer |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token 生命周期 |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token 生命周期 |
| `CORS_ORIGINS` | 空 | 允许的跨域浏览器 Origin，逗号分隔 |
| `TRUST_PROXY` | `false` | Express proxy 信任设置 |
| `JSON_BODY_LIMIT` | `1mb` | JSON body 上限 |
| `RATE_LIMIT_ENABLED` | `true` | 是否启用内存级基础限流 |

## 当前实施状态

协作 v1 的成员协作阶段 0-3 已落地：除阶段 0-1 的发布、快照和成员闭环外，现已包含持久 mutation 去重、严格实体版本、连续 Session 事件、REST 补拉、短期单次 WS ticket、鉴权 backlog/live WebSocket、Origin/连接限流，以及成员变更后的实时断连。快照接口支持 `includeDeleted=true`，供游标过期重装时在同一读事务返回活动 Log、tombstone 和 high watermark。配套客户端已接入本地事务 outbox、规范事件应用、崩溃恢复、角色同步、自动快照重装、安全三方 rebase 和冲突解决中心。

当前实时 hub 是进程内实现，生产环境必须保持单 Node.js 进程；启用 cluster 或多副本前需要加入跨实例 pub/sub。公开 Liveshare、事件裁剪与指标以及高级逐字段冲突编辑仍属于后续工作；旧 Liveshare 和未鉴权 WebSocket 不会重新挂载。
