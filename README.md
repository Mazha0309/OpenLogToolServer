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
openssl rand -hex 32 # JWT_SECRET
openssl rand -hex 24 # ADMIN_BOOTSTRAP_TOKEN
openssl rand -hex 32 # INVITE_HMAC_KEY
openssl rand -hex 32 # PUBLIC_SHARE_HMAC_KEY
~~~

把四个输出分别填入，四项不可复用同一个值：

~~~dotenv
JWT_SECRET=<至少 32 字节的随机值>
ADMIN_BOOTSTRAP_TOKEN=<至少 24 字节的随机值>
INVITE_HMAC_KEY=<至少 32 字节的独立随机值>
PUBLIC_SHARE_HMAC_KEY=<至少 32 字节的独立随机值>
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
| GET/PATCH | `/api/v1/admin/settings` | 管理员读取或幂等更新普通用户注册开关 |
| GET | `/api/v1/admin/users?q=&role=&page=&pageSize=` | 管理员分页搜索账户 |
| PATCH | `/api/v1/admin/users/:userId/role` | 幂等变更账户角色并撤销其活动 refresh token |
| POST | `/api/v1/admin/users/:userId/revoke-refresh-tokens` | 幂等撤销账户的活动 refresh token |
| GET | `/api/v1/admin/audit-events?...` | 按稳定 cursor 查询运行时管理审计 |
| GET | `/api/v1/admin/collaboration-metrics` | 管理员读取当前进程计数与当前数据库聚合指标 |
| GET | `/api/v1/admin/session-event-retention/preview` | 管理员只读预演 Session 事件裁剪 |
| POST | `/api/v1/admin/session-event-retention/prune` | 管理员显式、幂等执行有界 Session 事件裁剪 |
| GET/PUT | `/api/v1/sessions`、`/api/v1/sessions/:id` | 成员 Session 列表与幂等发布初始化 |
| POST | `/api/v1/sessions/:id/bootstrap/logs` | 分批写入发布快照（最多 500 条/批） |
| POST | `/api/v1/sessions/:id/activate` | 校验记录数并激活 Session |
| GET | `/api/v1/sessions/:id/snapshot` | 一致性完整快照 |
| GET | `/api/v1/sessions/:id/membership` | 当前成员权限 |
| DELETE | `/api/v1/sessions/:id/membership` | Editor/Viewer 幂等主动离开 Session |
| GET/PATCH/DELETE | `/api/v1/sessions/:id/members...` | Owner 成员管理 |
| POST | `/api/v1/sessions/:id/transfer-ownership` | 事务性转移所有权 |
| GET/POST/DELETE | `/api/v1/sessions/:id/invites...` | Owner 邀请管理 |
| GET | `/api/v1/sessions/:id/audit-events?...` | Owner 按稳定 cursor 查询协作安全审计 |
| GET/POST/DELETE | `/api/v1/sessions/:id/public-shares...` | Owner 创建、列出和撤销公开 Liveshare capability |
| POST | `/api/v1/collaboration-invites/redeem` | 原子、幂等兑换邀请码 |
| POST | `/api/v1/public-shares/:id/exchange` | 用公开链接 secret 换取 5 分钟 public access token |
| GET | `/api/v1/public/sessions/:id/snapshot` | 获取严格裁剪的公开完整快照 |
| POST | `/api/v1/public/sessions/:id/ws-ticket` | 创建 60 秒、单次使用的公开 WebSocket ticket |
| POST | `/api/v1/sessions/:id/mutations` | 批量提交独立原子的 Log/Session mutation |
| GET | `/api/v1/sessions/:id/events?afterSeq=N` | 按连续 Session seq 补拉规范事件 |
| POST | `/api/v1/sessions/:id/ws-ticket` | 创建 60 秒、单次使用的鉴权 WebSocket ticket |

实时连接使用 `/ws/collaboration?ticket=...`。服务端先发送 `hello`，连续投递 ticket cursor 之后的 backlog，再发送 `ready` 并进入 live；业务写入始终走 REST。每个 accepted mutation 的 REST event、`events` 补拉对象、数据库事件和 WebSocket event 是同一个规范对象。ticket 会绑定签发时的成员角色和版本，权限变化后的旧 ticket 不能消费；WS backlog 超过 1000 条时客户端必须先用 REST 补拉，慢消费者缓冲超过 8 MiB 会被要求重新同步。

`server-info.features` 包含 `publicLiveshare` 时，公开 Liveshare v1 服务端能力可用。Owner 可以为 `active` 或 `closed` Session 创建、列出和撤销公开链接；每个 Session 同时最多 20 个未撤销且未过期的链接，默认有效 24 小时、最长 30 天，并最多保留 5,000 条包含 active、expired、revoked 状态的公开链接历史，达到历史上限后拒绝继续创建。`GET /api/v1/sessions/:id/public-shares` 使用 `limit`（默认且最大 50）与不透明 `after` cursor 分页，响应固定包含 `publicShares` 和可为 `null` 的 `nextCursor`。创建响应中的 secret 由独立 `PUBLIC_SHARE_HMAC_KEY` 派生且只在首次创建或链接仍 active 时的精确幂等重放中返回，数据库中的 capability 行、持久幂等记录和审计都不保存明文 secret。若配置密钥与数据库指纹不匹配，服务器继续提供其他能力，但不宣告 `publicLiveshare`，相关 API 返回 503。

公开页面应从 `/live/{publicShareId}#token={secret}` 的 fragment 读取 secret，在内存中调用 exchange；服务端返回最长 5 分钟、`type=public-share-access` 且 audience 为 `openlogtool-public-v1` 的独立 JWT。该 token 只能读取绑定 Session 的公开 snapshot 和换取公开 WS ticket，不能充当成员 token。公开 snapshot 同时硬限 20,000 条未删除 Log 和 8 MiB 序列化 UTF-8 JSON，任一超限均返回 `413 PUBLIC_SNAPSHOT_TOO_LARGE`；进行中的 snapshot 全局最多 8 个、同一 share 最多 2 个，容量已满时返回 `429 PUBLIC_SNAPSHOT_BUSY` 和 `Retry-After: 1`。随后客户端以 `highWatermarkSeq` 获取 ticket 并连接 `/ws/public?ticket=...`。服务端按 `hello → backlog → ready → live` 投递同一连续 seq，backlog 上限 1000；超过上限时必须重新获取完整公开快照。

公开 snapshot 和 event 使用逐字段白名单 DTO：保留 Session 标题、状态及 Log 业务字段（包括电台设备字段 `device`），删除 actor、user/account ID、actor deviceId/sourceDeviceId、mutationId、entityVersion、成员、邀请和内部审计数据。同一 share 最多存在 8 张、同一 public JWT `jti` 最多存在 4 张未消费 ticket；签发前立即清理已过期 ticket，成功消费后在同一事务中删除 ticket 行。公开链接被 Owner 撤销、自然到期或所属 Session 删除后，exchange、REST、未消费 ticket 和现有 `/ws/public` 连接都会停止授权；Session 删除时，已连接页面先收到裁剪后的最终 `session.deleted` 再关闭。

生产默认启用实例内存限流：公开链接管理按 actor/IP/Session 为 60 次/分钟，并另按 actor/Session 限制为 120 次/分钟；exchange 按 IP 为 30 次/分钟、按 IP+share 为 10 次/分钟；snapshot 与 public WS ticket 分别按 IP+Session 为 30 次/分钟、按 share 为 60 次/分钟。这些限流桶、snapshot 并发计数与实时 hub 都是单进程内状态，生产环境必须保持单 Node.js 进程；多副本部署前需实现共享限流状态和跨实例 pub/sub。

Mutation 单批最多 100 个操作和 1 MiB。每个操作使用独立 UUID `mutationId`，重试必须复用；服务端把首次 accepted/conflict/rejected 结果持久化。Log 支持 create/update/delete/restore，Session Owner 支持 title update/close/reopen/delete，全部使用严格 `baseVersion`。Session 删除要求先关闭活动 Session；未完成发布的 `initializing` Session 可直接取消。成功删除会原子撤销邀请和 WS ticket、生成唯一最终 `session.deleted` 事件，并在广播终止事件后关闭该 Session 的实时连接。

`server-info.features` 包含 `collaborationSecurityAudit` 时，服务端支持 Session 级协作安全审计。审计记录成员、所有权、邀请、公开链接和 Session 删除的九种实际安全状态变化；公开链接对应 `public_share.created`、`public_share.revoked`。`GET /api/v1/sessions/:id/audit-events` 仅允许该 Session 的当前 Owner 调用；Session 软删除后，最终 Owner 仍可读取包含删除事件的审计记录。服务器全局 `admin` 身份不会旁路对象级 membership，未加入该 Session 时仍返回 `404 NOT_FOUND`。

协作审计查询支持 `action`、`actorUserId`、`targetUserId`、`from`、`to`、`cursor` 和 `limit`；`limit` 默认 50、最大 100，时间窗口为 `[from,to)`。结果按 `(occurredAt, auditEventId)` 倒序稳定分页，cursor 由服务端签名并绑定 Session、当前 Owner、过滤条件和分页边界，不能跨 Session、跨 Owner 或更换过滤条件复用。action 的 `before`、`after` 和 `details` 只接受严格白名单的安全元数据，不会从业务 payload 复制 Session 标题、Log 内容、邀请码或邀请链接、credential hash、密码/token、device、IP 或 User-Agent。

`requestId` 和 `mutationId` 是调用方提供并原样进入审计的关联标识；客户端必须使用随机 UUID，不得把邀请码、链接 token、密码或其他 secret 当作关联 ID。服务端的字段白名单用于阻断业务字段误写，不把允许任意 stable ID 的接口伪装成内容识别或数据防泄漏系统。

成员、所有权、邀请、公开链接及 Session 删除的业务变化、审计事件和幂等结果在同一个 SQLite 事务中提交；失败或精确重放不会产生重复审计。迁移 v10 不猜测或回填升级前的历史操作，只从迁移完成后开始记录；迁移 v11 保留既有审计并扩展公开链接 action；迁移 v12 保留既有管理审计并加入 `session_events.pruned`。审计表通过数据库 trigger 禁止普通 `UPDATE`/`DELETE`，用于阻止应用缺陷和常规 SQL 误改；这不是针对掌握宿主文件、服务进程或数据库管理权限者的防篡改存储，若有合规取证要求仍应外送到独立的追加式审计系统。

Access token 默认 15 分钟有效，refresh token 默认 30 天有效并在刷新时轮换。

v1 管理接口只授予服务器 control-plane 权限：聚合概览不返回 Session ID、标题、Owner、成员关系或 Log 内容，账户列表也不返回用户与 Session 的关联。全局 `admin` 不会因此获得 collaboration data-plane 权限；未成为成员时，访问 Session 快照、事件或 mutation 仍按对象级 membership 规则拒绝。

`collaborationOperationalMetrics` capability 对应的指标接口只返回固定维度：当前进程启动后的 HTTP、mutation、event、成员/公开 WebSocket 计数和延迟桶，以及当前数据库的 Session、Log、membership、活动 capability/ticket、事件保留量等聚合 gauge。它不返回 Session ID、标题、用户关联、Log 内容、IP 或 secret；进程计数在服务重启后从零开始，也不会跨 Node.js 实例合并。

`sessionEventRetention` capability 对应显式维护 API。preview 和 prune 的策略默认分别为保留 180 天、每个 Session 至少保留最新 10,000 条事件、单次最多纳入 100 个候选 Session，并由服务端再硬限单次最多删除 25,000 条；可请求的范围为 30..3650 天、1,000..1,000,000 条最低保留量和 1..100 个 Session。裁剪只删除严格早于 cutoff 的连续旧前缀，先单调推进 `min_retained_seq`，再删除对应 `session_events`；非规范时间（包括 SQLite 可解析但并非真实规范日期的值）、时间边界、序列缺口或并发游标变化都会阻止越界删除。`maxSessions` 限制纳入计划的候选数，不是 Session 元数据读取行数的硬预算；Session 目录极大时应先 preview，并把维护安排在低峰期。服务端不会自动调度裁剪，也不会顺带删除 Log/tombstone、幂等结果、审计、成员、邀请或公开链接，更不会自动执行 `VACUUM`。

四类服务器管理写操作（settings PATCH、角色变更、refresh token 撤销、事件 prune）都要求 `Idempotency-Key` 和严格 JSON 对象；refresh token 撤销可以不带正文，但不会把携带非 JSON 正文的请求误当成空命令。相同管理员用同一 key 重试同一路径和请求体会精确重放首次成功响应，并返回 `Idempotent-Replay: true`；key 被其他管理员、路径或请求体复用时返回 `409 MUTATION_ID_REUSED`。对应业务写、审计事件和幂等响应位于同一个 `BEGIN IMMEDIATE` 事务中，任一步失败都会整体回滚。

管理员不能修改自己的角色：有其他管理员时，自我角色变更返回 `409 SELF_ROLE_CHANGE_FORBIDDEN`；若该账户同时是最后一名管理员，自我降级返回更具体的 `409 LAST_ADMIN_REQUIRED`。两种情况都执行零写入。角色实际变化会撤销目标账户仍有效的 refresh token，现有无状态 access token 最多继续到自身过期，但管理接口每次都会同时检查 token claim 和数据库当前角色，所以被降级账户会立即失去 control-plane 权限。晋升账户需要重新登录后取得带新角色的 access token。

运行时管理审计记录注册开关、账户角色、refresh token 撤销和实际事件裁剪。只有 prune 确实删除事件时才写入 `session_events.pruned`，只记录删除数量、受影响 Session 数和策略，不记录 Session ID 或内容。`GET /api/v1/admin/audit-events` 支持 `action`、`actorUserId`、`targetUserId`、`from`、`to`、`cursor` 和 `limit`；时间窗口是 `[from,to)`，cursor 使用服务器密钥签名并与过滤条件、分页边界绑定，响应只返回管理事件白名单字段，不包含密码、token、IP、User-Agent 或协作数据。

旧 `/api/auth` 与 `/api/admin` 仅供现有管理后台过渡使用。旧管理鉴权同样实时复查数据库角色，旧设置写入也会记录管理审计。旧 `/api/sessions`、日志写入、`/api/shares`、Liveshare 与无鉴权 `/ws` 均不再挂载；迁移 v6 会统一撤销历史 `shares`，防止绕过 v1 成员权限、幂等与副本序列。

## 页面

- 管理后台：`/admin/`

公开 Liveshare v1 的服务端 API 和 `/ws/public` 已完成，但安全页面客户端仍暂停重写。仓库中的旧 `live` bundle 仍使用未鉴权 `/ws?sessionId=`、缺少初始快照，因而继续不挂载；在页面完成 fragment exchange、snapshot-first 和裁剪事件接入前，服务器不会恢复 `/live/*` 静态路由。

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
- 创建追加式运行时管理审计、角色约束与查询索引（迁移 v9）；
- 创建 Owner-only 的追加式协作安全审计及稳定查询索引（迁移 v10，不回填历史事件）；
- 创建只存 hash 的 `public_shares`、单次 `public_ws_tickets`，并无损扩展公开链接审计（迁移 v11）；
- 无损扩展管理审计的事件裁剪 action，并约束 Session 事件游标只能合法、单调前进（迁移 v12）；
- 将邀请码 HMAC 密钥指纹绑定到服务器数据库，阻止静默错换密钥；
- 启用 WAL、外键和 5 秒 busy timeout。

迁移 v9 会在启用账户管理写接口前校验历史 `users.role`：只接受 `admin`/`user`，且非空用户库必须至少保留一名管理员。发现损坏数据时服务器会拒绝启动，不会静默选择或提升任意账户；修复前应先备份数据库并明确核对管理员身份。

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
| `PUBLIC_SHARE_HMAC_KEY` | 无 | 必填，至少 32 字节；独立派生公开链接 secret，不得复用 JWT/邀请密钥 |
| `JWT_ISSUER` | `openlogtool-server` | JWT issuer |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token 生命周期 |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token 生命周期 |
| `CORS_ORIGINS` | 空 | 允许的跨域浏览器 Origin，逗号分隔 |
| `TRUST_PROXY` | `false` | Express proxy 信任设置 |
| `JSON_BODY_LIMIT` | `1mb` | JSON body 上限 |
| `RATE_LIMIT_ENABLED` | `true` | 是否启用实例内存级基础限流；生产环境应保持启用 |

## 当前实施状态

协作 v1 的成员协作阶段 0-3 已落地：除阶段 0-1 的发布、快照和成员闭环外，现已包含持久 mutation 去重、严格实体版本、连续 Session 事件、Session 删除终态、REST 补拉、短期单次 WS ticket、鉴权 backlog/live WebSocket、Origin/连接限流，以及权限/生命周期变化后的实时断连。快照接口支持 `includeDeleted=true`，供游标过期重装时在同一读事务返回活动 Log、tombstone 和 high watermark。配套客户端已接入本地事务 outbox、规范事件应用、崩溃恢复、角色同步、自动快照重装、安全三方 rebase 和冲突解决中心。

公开 Liveshare v1 的 Owner 管理、secret exchange、公开 snapshot、单次 ticket、`/ws/public`、立即撤销和安全审计已经在服务端落地；事件保留 preview/prune 与协作运维指标也已完成。因此，单 Node.js 实例范围内的协作 v1 服务端 API 已达到功能完整。安全 Liveshare 页面和管理 WebUI 客户端仍待重写，旧 Liveshare bundle 与未鉴权 WebSocket 不会重新挂载；成员/公开实时 hub、限流、并发计数和运行时指标也仍是进程内状态，启用 cluster 或多副本前需要加入共享限流状态、跨实例 pub/sub 与指标汇聚。高级逐字段冲突编辑属于客户端后续体验完善，不是服务端 API 缺口。
