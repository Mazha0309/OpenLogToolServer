# OpenLogTool Session 协作 v1 设计

> 状态：阶段 0-3 的成员协作核心已实现并验证；高级逐字段冲突 UI、公开 Liveshare 与阶段 4 运维项待实施
> 日期：2026-07-12
> 适用仓库：`openlogtool`、`OpenLogToolServer`
> 协议主版本：`1`

## 1. 决策摘要

OpenLogTool 的“协作”定义为：多个已授权成员操作同一个远端 Session，并在本地保留可恢复的副本。

v1 采用以下原则：

- 服务端数据库是协作状态的最终权威。
- Flutter/Rust 本地数据库是 materialized view、离线缓存和待发送操作队列。
- REST 接受写操作、返回规范化结果；WebSocket 只负责投递可能重复或延迟的事件。
- 每次写入都有持久化的 `mutationId`，每个实体都有 `version`，每个 Session 都有连续递增的 `seq`。
- 初始快照、事件补拉和 WebSocket 使用同一套事件语义。
- 成员邀请码与公开 Liveshare 链接是两种独立 capability。
- Session 元数据和 Log 进入协作；词典、主题、导出设置、呼号/QTH 历史继续保留在设备本地。
- 网络 JSON 一律使用 camelCase；SQLite 列名继续使用 snake_case，二者通过显式 DTO 转换。
- v1 不做 CRDT，也不按客户端时间做 Last-Writer-Wins；并发修改使用版本检查和显式冲突处理。

当前 `uploadSession()/downloadSession()` 快照式实现不再作为协作数据通道。旧接口可在迁移期保留，但新客户端只使用 `/api/v1`。

## 2. 背景与现有断点

当前两端已经具备认证、Session、Log、分享码和 WebSocket 骨架，但还没有形成可用的多人协作闭环：

1. 客户端存在上传方法，但当前 UI 没有可达的上传入口；生成邀请码前服务端通常还没有对应 Session。
2. 客户端和服务端字段不一致：`report`/`rstSent`/`rst_sent`、`rstRcvd`、`remarks` 的映射会丢数据。
3. “加入协作”只下载一次快照，再创建新的本地 Session；没有保留远端 Session ID，也没有建立成员关系。
4. Flutter 的后续 Log 增删改只写本地 Rust SQLite，不会提交服务端。
5. Liveshare 页面只监听未来 WebSocket 消息，不加载已有日志。
6. 服务端 Log 没有 `(session_id, sync_id)` 唯一约束，重复请求可能产生重复行。
7. 服务端构建不会把 `schema.sql` 复制到 `dist`，干净部署可能无法初始化数据库。
8. WebSocket 没有成员鉴权、断线补拉、事件游标或缺口检测。

本设计取代旧文档中“上传/下载即协作”的部分；本地 Rust 数据迁移、词典和导出设计不受影响。

## 3. 目标与非目标

### 3.1 v1 目标

- Owner 可以把一个本地 Session 发布为协作 Session，完整保留全部 Log 的 ID、业务时间和字段。
- Owner 可以创建 Editor 或 Viewer 邀请。
- 受邀用户加入同一个 Session，而不是创建逻辑上无关的副本。
- Owner 和 Editor 的新增、修改、删除、恢复可以实时传播。
- Viewer 可以实时查看，但不能写入。
- 客户端断线、重启、请求超时或 WebSocket 重连后能够最终收敛。
- 同一个请求重复发送不会重复写入。
- 并发编辑可以稳定检测冲突，不会静默覆盖或复活已删除记录。
- 公开 Liveshare 打开时先获得完整快照，再持续接收实时事件。
- 权限被撤销后，REST、快照、事件补拉和 WebSocket 都立即停止授权。

### 3.2 v1 非目标

- 不同步设备词典、主题、字体、导出设置或呼号/QTH 历史。
- 不实现字段级 CRDT 或任意文本协同编辑。
- 不支持一个协作 Session 同时绑定多个服务端实例。
- 不保证撤销成员后远程擦除其设备上已经下载的数据。
- 不在 WebSocket 上接受业务写命令；所有业务写入仍走 REST。
- 不要求后台常驻同步所有历史 Session；当前打开的 Session 保持实时，其余 Session 在打开或应用唤醒时补同步。

## 4. 术语与身份

| 名称 | 含义 |
|---|---|
| `serverInstanceId` | 服务端首次初始化时生成并持久化的 UUID，用于区分不同服务器 |
| `accountId` | 当前登录用户 ID |
| `deviceId` | 客户端安装级 UUID，持久化后保持稳定 |
| `sessionId` | 客户端创建的全局 UUID；发布后本地和服务端保持相同 |
| `syncId` | Log 的全局 UUID；SQLite 自增 ID 永不进入网络协议 |
| `mutationId` | 一次逻辑写操作的 UUID；所有重试复用同一个值 |
| `version` | 单个 Session 或 Log 的服务端版本，从 1 开始递增 |
| `seq` | 单个 Session 的连续事件序号，从 1 开始递增 |
| `cursor` | 客户端已经连续应用的最大 Session `seq` |
| `shadow` | 客户端保存的服务端规范实体，用于叠加本地未提交修改 |
| `outbox` | 已在本地生效、尚未由服务端规范事件确认的 mutation 队列 |

所有 UUID 使用小写标准 UUID 字符串。所有协议时间使用 UTC RFC 3339。

业务字段 `time` 表示通联/点名发生时间，由用户输入或客户端生成；`createdAt`、`updatedAt`、事件时间、版本和过期判断由服务端生成，不能用于替代业务时间。

## 5. 角色和权限

Session 角色固定为：

- `owner`：管理 Session、成员、邀请、公开链接，并拥有编辑权限。
- `editor`：查看并增删改 Log。
- `viewer`：只读查看 Session 和 Log。

服务端全局 `admin` 角色与 Session 成员角色分离。全局管理员不会因为 `admin` JWT claim 自动获得任意 Session 的业务数据访问权。

| 操作 | owner | editor | viewer | public live |
|---|:---:|:---:|:---:|:---:|
| 获取 Session 快照/事件 | ✓ | ✓ | ✓ | 受限 DTO |
| 新增、修改、删除、恢复 Log | ✓ | ✓ |  |  |
| 修改 Session 标题 | ✓ |  |  |  |
| 关闭/重新打开 Session | ✓ |  |  |  |
| 创建/撤销成员邀请 | ✓ |  |  |  |
| 查看/移除成员 | ✓ |  |  |  |
| 转移所有权 | ✓ |  |  |  |
| 创建/撤销 Liveshare | ✓ |  |  |  |

规则：

- 一个未删除 Session 必须且只能有一个 owner。
- Owner 不能直接离开；必须先转移所有权，或关闭并删除 Session。
- 邀请不能授予 owner。
- Session 为 `closed` 时所有成员仍可读，但任何业务写入返回 `SESSION_CLOSED`。
- Session 删除是软删除并生成最后一个 `session.deleted` 数据事件；公开链接立即撤销。
- 删除时仍有效的成员可以在保留期内补拉到这个终止事件，但不能再获取新的业务写权限。
- 成员被移除后，其本地缓存保留为只读；可以导出或 fork 为新的本地 Session，但不得继续上传。

## 6. 总体架构

~~~text
Flutter UI / Provider
        │ 用户命令、状态展示
        ▼
Rust replica engine ───── SQLite
  materialized rows        shadow / outbox / cursor / conflicts
        ▲                       │
        │ canonical event       │ pending mutations
        │                       ▼
Dart CollaborationCoordinator / ServerApi
        │ REST writes + snapshot/events
        │ authenticated WebSocket
        ▼
OpenLogToolServer
  auth / membership / mutation processor / event store
        │
        ▼
SQLite (authoritative)
~~~

职责边界：

- Rust 在同一个 SQLite 事务中完成“本地业务修改 + 写 outbox”。
- Rust 在同一个 SQLite 事务中完成“应用服务端事件 + 更新 shadow/materialized view + 推进 cursor”。
- Dart 保存安全凭证、执行 HTTP/WS、调度重试，并把 outbox 与规范事件在 Rust API 边界上传递。
- Flutter 不直接拼网络 DTO，也不在 Provider 回调中另走一条上传路径。
- 服务端在同一个 SQLite 事务中完成“权限/版本检查 + 状态写入 + seq 递增 + 事件持久化 + mutation 去重结果”。
- 服务端事务提交后才广播 WebSocket；WebSocket 广播失败不回滚已经提交的数据。

v1 保留 Dart 作为网络传输层，避免在 Rust 中同时引入跨平台 HTTP、WebSocket、TLS 和 token 存储。未来可以把 transport 下沉到 Rust，但不得改变协议或本地事务不变量。

## 7. 协议通用规则

### 7.1 版本与字段

- 所有 v1 DTO 携带 `protocolVersion: 1`，或通过 `/api/v1` 路径确定主版本。
- 接收方忽略未知的可选字段，但拒绝不支持的主版本。
- API JSON 使用 `sessionId`、`syncId`、`rstSent`、`rstRcvd`、`createdAt` 等 camelCase 名称。
- 更新 patch 中字段缺失表示“不修改”；显式 `null` 表示清空可空字段。
- 服务端返回的规范实体必须包含完整字段，不能只返回请求 patch。

### 7.2 请求追踪和错误

服务端为每个请求生成或透传 `X-Request-Id`。错误统一为：

~~~json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "The log has changed on the server.",
    "requestId": "uuid",
    "details": {}
  }
}
~~~

常用状态：

| HTTP | code | 含义 |
|---:|---|---|
| 400 | `INVALID_REQUEST` | JSON、字段或状态转换非法 |
| 401 | `AUTH_REQUIRED` / `TOKEN_EXPIRED` | 需要登录或刷新 token |
| 403 | `FORBIDDEN` / `MEMBERSHIP_REVOKED` | 身份存在但无对象权限 |
| 404 | `NOT_FOUND` | 对象不存在，或为避免 IDOR 不暴露其存在 |
| 409 | `VERSION_CONFLICT` | `baseVersion` 过期 |
| 409 | `MUTATION_ID_REUSED` | 同一 mutationId 被用于不同请求 |
| 409 | `SESSION_ID_UNAVAILABLE` | Session ID 已被其他身份占用 |
| 410 | `CURSOR_EXPIRED` | 事件已被裁剪，必须重拉快照 |
| 422 | `VALIDATION_FAILED` | 业务字段不符合约束 |
| 429 | `RATE_LIMITED` | 尊重 `Retry-After` |

邀请无效、已过期、已撤销和已用尽对调用方统一返回 `INVITE_INVALID`，避免泄露 Session 信息。

### 7.3 幂等规则

- 普通管理写接口使用 `Idempotency-Key` 请求头，值为 UUID。
- `/mutations` 中的每个操作使用自己的 `mutationId`。
- 重试必须复用原 ID；客户端不得在超时后生成新 ID。
- 服务端持久化请求 hash 和规范响应。
- 相同 ID、相同请求返回第一次的结果；相同 ID、不同请求返回 `MUTATION_ID_REUSED`。
- 去重不能只保存在 Node.js 内存中。

## 8. 服务端数据模型

### 8.1 迁移机制

服务端改为编号迁移，不再只在启动时执行一份 `CREATE TABLE IF NOT EXISTS`：

~~~text
src/db/migrations/
  001_initial.sql
  002_collaboration_v1.sql
  ...
~~~

新增 `schema_migrations(version, name, checksum, applied_at)`。迁移按事务顺序执行，checksum 改变时拒绝启动。

构建脚本必须显式把迁移文件复制进 `dist/db/migrations`。CI 必须用正式 `dist/index.js` 和空临时目录启动一次，防止再次出现源码可运行、生产包缺 SQL 资产的问题。

### 8.2 sessions

现有 `sessions` 增加：

| 字段 | 约束 | 说明 |
|---|---|---|
| `version` | INTEGER NOT NULL DEFAULT 1 | Session 元数据版本 |
| `event_seq` | INTEGER NOT NULL DEFAULT 0 | 当前最大连续事件序号 |
| `min_retained_seq` | INTEGER NOT NULL DEFAULT 0 | 事件裁剪下界 |
| `status` | initializing/active/closed | 发布与写入状态 |
| `closed_at` | nullable | 关闭时间 |
| `closed_by` | FK users | 关闭者 |

`owner_user_id` 暂时保留，且必须与唯一 owner membership 一致。所有权转移在一个事务中同时更新两处。

删除继续使用 `deleted_at` tombstone。删除事务会撤销 invite/public share、写入终止事件，但保留 membership 和事件，供删除时仍有效的成员补拉。删除后的 snapshot 返回 `SESSION_DELETED` 及终止元数据，不再返回完整远端数据；客户端使用已经持久化的本地副本完成归档、导出或 fork。

### 8.3 session_members

~~~sql
CREATE TABLE session_members (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  removed_by TEXT REFERENCES users(id),
  UNIQUE(session_id, user_id)
);
~~~

所有 Session API 和 WebSocket 订阅都实时查询 membership，不信任 JWT 中的 Session 权限。

### 8.4 logs

`logs` 规范字段：

| 字段 | 说明 |
|---|---|
| `sync_id` | 客户端生成的稳定 UUID |
| `session_id` | 所属 Session |
| `version` | 从 1 开始，每次 update/delete/restore 加 1 |
| `time` | 业务发生时间，UTC RFC 3339 |
| `controller` / `callsign` | 服务端 trim 并转大写 |
| `rst_sent` / `rst_rcvd` | 可空 |
| `qth` / `device` / `power` / `antenna` / `height` / `remarks` | 可空 |
| `created_at` / `updated_at` | 服务端时间 |
| `created_by` / `updated_by` | 用户 ID |
| `source_device_id` | 发起 mutation 的设备 ID |
| `deleted_at` / `deleted_by` | tombstone |

必须建立：

~~~sql
UNIQUE(session_id, sync_id)
INDEX logs(session_id, deleted_at, time)
~~~

已删除 Log 不接受旧 update。恢复是独立操作，并要求 tombstone 当前版本。

### 8.5 session_events

~~~sql
CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  mutation_id TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_device_id TEXT,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE INDEX idx_session_events_after
ON session_events(session_id, seq);
~~~

这里只保存所有成员和公开 Liveshare 都可以按序消费的 Session/Log 数据事件。成员管理、安全审计等不进入这条连续数据流，避免不同订阅者因事件过滤产生 seq 缺口。

v1 事件先永久保留。后续启用裁剪时，必须先更新 `min_retained_seq`；旧 cursor 统一返回 `CURSOR_EXPIRED`。

### 8.6 processed_mutations

~~~sql
CREATE TABLE processed_mutations (
  mutation_id TEXT PRIMARY KEY,
  session_id TEXT,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
~~~

该表负责跨请求、跨连接和服务重启去重。v1 不自动清理；若以后清理，保留时间必须大于客户端允许的最长离线时间。

### 8.7 collaboration_invites

| 字段 | 说明 |
|---|---|
| `id` | UUID |
| `session_id` | 固定 Session |
| `code_hash` | 只存规范化邀请码的 HMAC-SHA-256 |
| `link_token_hash` | 可选邀请链接的 128-bit secret hash |
| `code_hint` | 仅用于列表展示的末 4 位 |
| `role` | editor 或 viewer |
| `max_uses` / `used_count` | 使用限制 |
| `expires_at` | 服务端判断 |
| `created_by` / `created_at` | 创建审计 |
| `revoked_at` / `revoked_by` | 撤销审计 |

手工邀请码使用 10 位 Crockford Base32，默认 24 小时、一次使用；兑换要求登录，并按 IP、账号和邀请码做严格限流。`code_hash` 使用独立服务端 pepper 做 HMAC，避免只泄露数据库时离线枚举短码。邀请链接使用同一 invite 记录上的独立 128-bit secret。邀请码和链接 secret 都只在创建响应中返回一次，之后列表只返回 code hint。

邀请码兑换必须在同一事务中：

1. 校验 hash、期限、撤销和使用次数。
2. 创建或返回已有 membership。
3. 原子增加 `used_count`。
4. 持久化 `joinRequestId` 的幂等结果。

同一用户重试成功过的兑换不重复消耗次数。

### 8.8 public_shares

公开 Liveshare 与成员邀请分表：

- token 至少 128 bit，只存 hash。
- 可配置过期时间并随时撤销。
- 只授予公开快照和数据事件读取权限。
- 不创建 membership，不能兑换成 editor/viewer。
- 返回公开 DTO 时移除 userId、deviceId、mutationId 和内部版本细节。

推荐分享 URL：

~~~text
https://server/live/{publicShareId}#token={secret}
~~~

token 位于 URL fragment，不会随页面请求或 Referer 自动发送。页面加载后用 token 换取短期公开 WS ticket。

### 8.9 其他安全表

实现认证加固时增加：

- `refresh_tokens`：保存 refresh token hash、设备、过期、轮换和撤销状态。
- `ws_tickets`：短期、单次使用，绑定 user/public capability、Session、device 和 afterSeq。
- `collaboration_audit_events`：迁移 v10 起追加记录成员、邀请、所有权和 Session 删除等安全事件；公开链接尚未实现，后续接入时必须纳入同类审计。

`collaboration_audit_events` 与所有成员共用的连续 `session_events` 分离。前者只供当前 Owner 查询，不占用 Session data event 的 seq，也不会因为成员级可见性不同而制造事件缺口。成员、所有权、邀请或 Session 删除发生实际变化时，业务状态、审计行与幂等结果必须在同一个事务中提交；失败、冲突、no-op 和精确重放不得产生重复审计。

审计持久化只接受每种 action 的固定字段白名单，不接受任意请求对象或业务 payload。`before`、`after` 和 `details` 禁止写入 Session 标题、Log 内容、邀请码、邀请链接 secret、credential hash、密码/token、device、IP 和 User-Agent。`requestId`、`mutationId` 是调用方提供并原样保存的关联标识，调用方必须使用随机 UUID，严禁把 credential 或其他 secret 放入 ID 字段。表级 trigger 禁止普通 `UPDATE`、`DELETE` 以及冲突替换写入，用于防止应用缺陷或常规 SQL 误改；它不是对掌握宿主文件、进程或数据库管理权限者的防篡改保证，需要强取证能力时应另行外送到独立追加式存储。

## 9. REST API v1

### 9.1 服务信息与认证

~~~text
GET  /api/v1/server-info
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET  /api/v1/auth/me
~~~

`server-info` 返回：

~~~json
{
  "serverInstanceId": "uuid",
  "protocolMin": 1,
  "protocolMax": 1,
  "features": ["collaboration", "collaborationSecurityAudit"],
  "serverTime": "2026-07-11T08:00:00Z"
}
~~~

Access token 短期有效，refresh token 轮换。Flutter 使用系统安全存储保存 token，不再放在 SharedPreferences。

客户端仅在 `features` 包含 `collaborationSecurityAudit` 时展示或调用 Session 安全审计入口。

### 9.2 发布本地 Session

发布使用可恢复的三阶段流程，避免一次上传受内存、500 条 UI 分页或网络中断限制。

#### 创建 initializing Session

~~~text
PUT /api/v1/sessions/{sessionId}
Idempotency-Key: uuid
~~~

~~~json
{
  "title": "2026-07-11 晚点名"
}
~~~

首次创建时服务端同时创建 owner membership。相同 owner 重试返回现有 initializing Session；ID 已被其他用户占用时返回 `SESSION_ID_UNAVAILABLE`。

#### 分批上传初始日志

~~~text
POST /api/v1/sessions/{sessionId}/bootstrap/logs
Idempotency-Key: uuid
~~~

~~~json
{
  "items": [
    {
      "syncId": "uuid",
      "time": "2026-07-11T07:58:00Z",
      "controller": "BG5CRL",
      "callsign": "BA4AAA",
      "rstSent": "59",
      "rstRcvd": "57",
      "qth": "上海",
      "device": "IC-705",
      "power": "10W",
      "antenna": "DP",
      "height": "8m",
      "remarks": "移动台"
    }
  ]
}
~~~

- 每批最多 500 条或 1 MiB。
- 仅 owner、仅 `initializing` 状态允许调用。
- 服务端保留传入 `syncId` 和 `time`，其余字段按统一规则规范化。
- 相同 `syncId`、相同规范内容视为幂等；内容不同返回 `BOOTSTRAP_ENTITY_MISMATCH`。
- 客户端必须直接从 Rust 数据库分页读取全部日志，不能使用 UI 当前最多 500 条的内存列表。

#### 激活

~~~text
POST /api/v1/sessions/{sessionId}/activate
Idempotency-Key: uuid
~~~

~~~json
{
  "expectedLogCount": 1280
}
~~~

服务端核对数量后切换到 `active`，生成 `session.activated` 事件并返回 `highWatermarkSeq`。激活后禁止再次调用 bootstrap 接口，所有变化进入 mutation/event 协议。

发布失败时客户端保留 `initializing` 绑定并可继续重试。超过 7 天未完成的 initializing Session 可以由 owner 删除或由维护任务清理。

### 9.3 Session 查询、快照与事件

~~~text
GET /api/v1/sessions
GET /api/v1/sessions/{sessionId}/snapshot
GET /api/v1/sessions/{sessionId}/snapshot?includeDeleted=true
GET /api/v1/sessions/{sessionId}/events?afterSeq=N&limit=500
~~~

快照响应：

~~~json
{
  "protocolVersion": 1,
  "session": {
    "sessionId": "uuid",
    "title": "晚点名",
    "status": "active",
    "version": 3,
    "role": "editor"
  },
  "highWatermarkSeq": 120,
  "includesDeletedLogs": false,
  "logs": []
}
~~~

服务端必须在一个一致的 SQLite 读事务中读取 Session、Log 和 `highWatermarkSeq`。普通快照只返回未删除 Log，并标记 `includesDeletedLogs: false`；仅精确指定 `includeDeleted=true` 的重装快照同时返回 tombstone，并标记 `includesDeletedLogs: true`。v1 返回完整快照并启用 gzip；实现至少以 20,000 条 Log 作为自动化性能基线。若未来增加分页，所有页面必须绑定不可变 `snapshotId`，不能对变化中的表做普通 offset 分页。

快照是服务端规范基线：安装或重装时，客户端必须移除/标记删除那些“不在快照中且没有本地 pending mutation”的旧 shadow 和 materialized Log。存在 pending mutation 的实体先保留本地 overlay，再按新基线 rebase 或创建冲突。

事件补拉响应：

~~~json
{
  "afterSeq": 120,
  "toSeq": 123,
  "headSeq": 130,
  "minAvailableSeq": 0,
  "hasMore": true,
  "events": []
}
~~~

客户端必须逐页连续应用到 `headSeq`。`afterSeq < minAvailableSeq` 返回 `CURSOR_EXPIRED`。

Session 已删除时，删除时仍有效的成员可以继续调用 events 接口取得终止 `session.deleted` 事件；snapshot 返回 `410 SESSION_DELETED` 和 `deletedAt/finalSeq`，不返回完整 Log。其他身份仍统一得到 `NOT_FOUND`。

### 9.4 成员与邀请

~~~text
GET    /api/v1/sessions/{sessionId}/membership
GET    /api/v1/sessions/{sessionId}/members
DELETE /api/v1/sessions/{sessionId}/members/{userId}
POST   /api/v1/sessions/{sessionId}/transfer-ownership

POST   /api/v1/sessions/{sessionId}/invites
GET    /api/v1/sessions/{sessionId}/invites
DELETE /api/v1/sessions/{sessionId}/invites/{inviteId}
POST   /api/v1/collaboration-invites/redeem
~~~

创建邀请：

~~~json
{
  "role": "editor",
  "expiresInHours": 24,
  "maxUses": 1
}
~~~

兑换邀请：

~~~json
{
  "code": "ABCD-EFGH-JK",
  "linkToken": null,
  "joinRequestId": "uuid",
  "deviceId": "uuid"
}
~~~

请求必须在 `code` 和 `linkToken` 中二选一。`joinRequestId` 是兑换操作的幂等键；若同时发送 `Idempotency-Key`，两者必须相同。兑换只返回 membership、Session 摘要和当前 headSeq；客户端随后调用快照接口安装副本。

成员移除或角色变更后，服务端主动向相关 WebSocket 发送 control message 并关闭不再授权的连接。所有后续 API 仍重新查询数据库权限，不能只依赖连接建立时的结果。

`membership` 接口允许当前成员读取自己的最新 role、membership version 和 removed 状态。每次重连都调用它，确保离线期间发生的角色变化不会只依赖易丢失的 control message。

#### 协作安全审计

~~~text
GET /api/v1/sessions/{sessionId}/audit-events
GET /api/v1/sessions/{sessionId}/audit-events?action=invite.created&limit=50
~~~

迁移 v10 起记录以下七种 action：

- `membership.role.updated`
- `membership.removed`
- `ownership.transferred`
- `invite.created`
- `invite.redeemed`
- `invite.revoked`
- `session.deleted`

接口只允许 Session 的当前 Owner 读取。editor、viewer 和已移除成员不能读取；服务器全局 `admin` 也不获得 data-plane 旁路，未成为该 Session 成员时仍返回 `404 NOT_FOUND`。Session 软删除后不再允许普通协作写入，但删除时的最终 Owner 仍可读取包含 `session.deleted` 的安全审计。

查询参数严格限制为 `action`、`actorUserId`、`targetUserId`、`from`、`to`、`cursor` 和 `limit`。`limit` 默认 50、最大 100，时间范围采用 `[from,to)`；结果按 `(occurred_at DESC,id DESC)` 排序并使用 limit+1 判断后页。cursor 为服务端签名的 opaque base64url 值，同时绑定 Session ID、当前 Owner、全部过滤条件和分页边界；篡改、跨 Session/Owner 使用或改变过滤条件均返回 `VALIDATION_FAILED`。

响应只暴露 `auditEventId`、`action`、`actorUserId`、`targetUserId`、经 action 白名单校验的 `before`/`after`/`details`、`requestId`、`mutationId` 和 `occurredAt`，并返回 `pageInfo.limit/hasMore/nextCursor`。白名单状态对象不返回 Session 标题、Log 或 mutation payload，也不复制邀请码、链接 token、任何 credential hash、密码/token、device、IP 或 User-Agent。关联 ID 会原样返回，因此客户端必须遵守上述 UUID/禁止 secret 合同。读取权限检查和分页查询在同一个一致读事务中完成。

### 9.5 mutations

~~~text
POST /api/v1/sessions/{sessionId}/mutations
~~~

单批最多 100 个操作或 1 MiB。客户端同一批对同一实体最多发送一个操作。

~~~json
{
  "protocolVersion": 1,
  "deviceId": "uuid",
  "operations": [
    {
      "mutationId": "uuid",
      "entityType": "log",
      "entityId": "uuid",
      "operation": "update",
      "baseVersion": 7,
      "observedSeq": 120,
      "patch": {
        "qth": "上海",
        "remarks": "移动台"
      },
      "queuedAt": "2026-07-11T08:00:00Z"
    }
  ]
}
~~~

操作规则：

- Log `create`：`baseVersion = 0`，携带完整 `value`。
- Log `update`：携带 `baseVersion` 和 `patch`。
- Log `delete`：携带 `baseVersion`，无业务 payload。
- Log `restore`：基于 tombstone 当前版本，携带需要恢复的完整值或确认标记。
- Session `update`、`close`、`reopen`、`delete`：`entityType = session`，仅 owner。活动 Session 必须先 `close` 再 `delete`；`initializing` 可直接删除以取消发布。
- `queuedAt` 只用于诊断，不参与排序、版本或冲突决策。

服务端按请求顺序处理，但每个 mutation 独立原子，整批不是 all-or-nothing。进程在批处理中断后，重试会从 `processed_mutations` 返回已完成项并继续未完成项。

响应：

~~~json
{
  "headSeq": 121,
  "results": [
    {
      "mutationId": "uuid",
      "status": "accepted",
      "event": {}
    },
    {
      "mutationId": "uuid",
      "status": "conflict",
      "code": "VERSION_CONFLICT",
      "currentVersion": 9,
      "currentEntity": {}
    }
  ]
}
~~~

Session 级认证或请求结构错误使用 HTTP 4xx。单个 mutation 的冲突、永久校验失败等通过 `results` 返回，不阻塞其他实体。

### 9.6 WebSocket ticket

~~~text
POST /api/v1/sessions/{sessionId}/ws-ticket
~~~

~~~json
{
  "deviceId": "uuid",
  "afterSeq": 120
}
~~~

响应包含当前 role、membershipVersion，以及 60 秒有效、单次使用、绑定账号/Session/device/cursor 的随机 ticket。浏览器和客户端都不把长期 JWT 放进 WebSocket URL。

### 9.7 公开 Liveshare

~~~text
POST   /api/v1/sessions/{sessionId}/public-shares
GET    /api/v1/sessions/{sessionId}/public-shares
DELETE /api/v1/sessions/{sessionId}/public-shares/{shareId}

POST /api/v1/public-shares/{shareId}/exchange
GET  /api/v1/public/sessions/{sessionId}/snapshot
POST /api/v1/public/sessions/{sessionId}/ws-ticket
~~~

公开 access token 只能调用绑定 Session 的只读接口。Liveshare 页面必须先安装完整公开快照，再从 `highWatermarkSeq` 连接事件流。

## 10. 规范事件

REST accepted 结果、事件补拉和 WebSocket 使用同一个事件信封：

~~~json
{
  "protocolVersion": 1,
  "eventId": "uuid",
  "sessionId": "uuid",
  "seq": 121,
  "type": "log.updated",
  "entityType": "log",
  "entityId": "uuid",
  "entityVersion": 8,
  "mutationId": "uuid",
  "actor": {
    "userId": "uuid",
    "deviceId": "uuid",
    "displayName": "BG5CRL"
  },
  "occurredAt": "2026-07-11T08:00:01Z",
  "payload": {
    "syncId": "uuid",
    "sessionId": "uuid",
    "version": 8,
    "time": "2026-07-11T07:58:00Z",
    "controller": "BG5CRL",
    "callsign": "BA4AAA",
    "rstSent": "59",
    "rstRcvd": "57",
    "qth": "上海",
    "device": "IC-705",
    "power": "10W",
    "antenna": "DP",
    "height": "8m",
    "remarks": "移动台",
    "createdAt": "2026-07-11T08:00:00Z",
    "updatedAt": "2026-07-11T08:00:01Z",
    "deletedAt": null
  }
}
~~~

事件类型：

- `session.activated`
- `session.updated`
- `session.closed`
- `session.reopened`
- `session.deleted`
- `log.created`
- `log.updated`
- `log.deleted`
- `log.restored`

`payload` 对实体事件始终携带完整规范实体。公开流使用删减 actor/internal 字段后的 DTO，但保留相同 `seq`。

## 11. WebSocket 协议

连接：

~~~text
GET /ws/collaboration?ticket={singleUseTicket}
~~~

服务端握手顺序：

1. 原子消费 ticket，并重新确认 Session 和 membership。
2. 注册连接进入 catch-up 状态，对新提交事件先缓冲。
3. 根据 ticket 绑定的 `afterSeq` 从数据库发送连续 backlog。
4. 发送 `ready`，其中 `cursor` 是已连续投递的当前游标。
5. 按 seq 刷新握手期间缓冲的事件，然后进入 live。

消息：

~~~json
{"type":"hello","sessionId":"uuid","headSeq":130,"heartbeatIntervalMs":20000}
{"type":"event","event":{}}
{"type":"ready","cursor":130}
{"type":"resyncRequired","minAvailableSeq":500}
{"type":"accessRevoked","reason":"MEMBERSHIP_REVOKED"}
~~~

约束：

- WebSocket 可能产生重复投递；客户端按 `eventId` 和 `seq` 去重。
- 客户端只允许连续推进 cursor；发现 `seq > cursor + 1` 时暂停越序应用并调用 events API 补缺口。
- `seq <= cursor` 视为重复；若相同 seq 的 eventId 不同，记录协议分叉并强制重拉快照。
- WebSocket 不接受业务 mutation。
- ping/pong 超时、发送失败或权限变化时服务端主动关闭连接。
- 服务端重启会关闭连接；客户端必须通过 `afterSeq` 恢复，不能假设重连即完整。
- 每个 Session、用户和 IP 都限制连接数与建连速率。
- membership control message 不占用 Session 数据 seq；客户端重连时必须通过 membership/ticket 响应刷新权限。

## 12. 服务端 mutation 事务

每个 mutation 的处理顺序固定：

1. 开启 SQLite 写事务。
2. 查询 `processed_mutations`。
3. 若已存在，比较 request hash 并返回第一次结果。
4. 从数据库查询当前 membership 和 Session 状态。
5. 校验角色、字段、`baseVersion` 和 tombstone。
6. 更新实体并令实体 version 加 1。
7. 令 `sessions.event_seq` 加 1，得到新 seq。
8. 插入完整规范 `session_events`。
9. 把规范结果写入 `processed_mutations`。
10. 提交事务。
11. 使用同一事件对象广播 WebSocket。

任何步骤失败都不产生半条业务数据或无实体的事件。广播发生在提交之后。

## 13. 冲突规则

- Create：`syncId` 不存在时创建；已存在且不是同一幂等 mutation 时返回冲突。
- Update：`baseVersion == currentVersion` 才接受。
- Delete：基于当前版本生成 tombstone；旧 update 不能复活 tombstone。
- Restore：是显式新操作，基于 tombstone 当前版本；不把旧 update 当作 restore。
- Session closed 后拒绝 Log mutation；离线 mutation 保留在客户端等待用户处理。
- 客户端时间、到达顺序和 WebSocket 顺序都不用于解决版本冲突。

服务端 `VERSION_CONFLICT` 返回完整当前实体。客户端用本地保存的 `baseJson`、待提交值和当前远端值做三方比较：

- 本地与远端修改字段不相交：自动 rebase 后生成新 mutation。
- 相同字段最终值相同：视为已经收敛。
- 相同字段值不同：创建显式冲突。
- 远端已删除、本地旧 update：删除获胜；用户可复制为新 Log。
- 本地 delete、远端 update：由用户选择采用远端或基于新版本重新删除。

冲突只暂停该实体的 outbox 链，不能阻塞其他实体、事件应用或 cursor 推进。

## 14. 客户端本地副本

### 14.1 Rust 职责

Rust replica engine 负责：

- 本地 Log/Session materialized view。
- 用户命令和 outbox 同事务写入。
- 服务端 shadow。
- snapshot 原子安装。
- 规范事件按序应用和 cursor 同事务推进。
- mutation ACK、重试状态与冲突记录。
- 为 Flutter 暴露协作状态流。

现有 `addLog/updateLog/deleteLog` 外部行为可以保留，但协作 Session 中内部写入必须同时创建 outbox。`LogProvider._onLogChanged` 一类网络回调退出数据通道，避免一次操作走两条上传路径。

### 14.2 Dart 职责

新增：

- `ServerApi`：认证、HTTP DTO、超时、错误解析。
- `CollaborationCoordinator`：每个当前 Session 的串行追平、outbox flush、WS 和退避。
- `CollaborationProvider`：只向 UI 暴露角色、连接状态、pending/conflict 数量和操作入口。

Access/refresh token 使用 `flutter_secure_storage`。SQLite、日志、SharedPreferences、URL 和 outbox 中不得出现长期 token。

### 14.3 本地表

Rust schema 新增或等价实现：

~~~sql
CREATE TABLE collaboration_bindings (
  server_instance_id TEXT NOT NULL,
  server_origin TEXT NOT NULL,
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  role TEXT NOT NULL,
  replica_state TEXT NOT NULL,
  last_applied_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_head_seq INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (server_instance_id, account_id, session_id)
);

CREATE TABLE entity_shadows (
  server_instance_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  server_version INTEGER NOT NULL,
  last_event_seq INTEGER NOT NULL,
  server_json TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (
    server_instance_id, account_id, session_id, entity_type, entity_id
  )
);

CREATE TABLE sync_outbox (
  local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  server_instance_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  base_version INTEGER,
  observed_seq INTEGER NOT NULL,
  base_json TEXT,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  accepted_event_seq INTEGER,
  depends_on_mutation_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE applied_events (
  server_instance_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (server_instance_id, account_id, session_id, event_id),
  UNIQUE(server_instance_id, account_id, session_id, event_seq)
);

CREATE TABLE sync_conflicts (
  conflict_id TEXT PRIMARY KEY,
  server_instance_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  base_version INTEGER,
  remote_version INTEGER NOT NULL,
  base_json TEXT,
  local_json TEXT NOT NULL,
  remote_json TEXT NOT NULL,
  conflicting_fields_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  resolution_mutation_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
~~~

另需安装级 `device_state` 保存稳定 `deviceId`，以及 snapshot staging 存储，保证下载中断时不覆盖当前可用副本。

所有 binding、shadow、outbox、cursor 和 conflict 都按 `serverInstanceId + accountId` 分区。切换账号或服务器后，旧身份的 outbox 绝不能发送。

### 14.4 outbox 状态

~~~text
pending -> sending -> accepted -> removed
              │          │
              ├-> retrying
              ├-> conflict
              └-> rejected
~~~

- `accepted` 表示 HTTP 已确认，但对应规范事件尚未事务性应用。
- 只有规范事件已经应用并确认 mutationId 后才删除 outbox。
- 网络错误、超时、5xx 和 429 可重试。
- 401 先刷新一次；失败进入 `authRequired`。
- 403 标记 binding revoked/forbidden，保留本地草稿。
- 409 进入冲突处理。
- 校验类永久 4xx 标记 rejected，不无限重试。

合并规则：

- 未发送 create + update：合并为完整 create。
- 从未尝试的 create + delete：取消两者和临时实体。
- 连续未发送 update：合并 patch，保留最初 baseVersion/baseJson。
- update + delete：合并为 delete。
- sending/accepted 不可改写；后续操作通过依赖关系排队。
- 同一实体顺序发送，不同实体可以批处理。

## 15. 客户端状态机

传输状态和副本状态分离：

~~~text
TransportPhase:
  stopped | connecting | online | backingOff |
  authRequired | incompatible

ReplicaPhase:
  localOnly | publishing | joining | snapshotting |
  catchingUp | ready | resyncing | revoked | failed
~~~

状态流至少暴露：

~~~text
sessionId
role
transportPhase
replicaPhase
lastAppliedSeq
serverHeadSeq
pendingCount
conflictCount
lastSuccessfulSyncAt
lastErrorCode
nextRetryAt
~~~

典型组合：

- `ready + online`：实时同步。
- `ready + backingOff`：离线可编辑，显示 pending 数量。
- `ready + pendingCount > 0`：有修改尚未被规范事件确认。
- `ready + conflictCount > 0`：其他实体仍继续同步。
- `revoked`：只读本地缓存，可导出或 fork。

## 16. 关键客户端流程

### 16.1 发布

1. 获取 `server-info` 并确认协议兼容。
2. 在一个本地事务中把 Session 绑定到 `serverInstanceId + accountId`、进入 `publishing`，并生成不可变 publish staging 快照。
3. 发布期间的新 Log 或修改继续正常写入 materialized view，同时进入 outbox；bootstrap 只读取 staging，避免分页过程中漏掉并发录入。
4. 创建远端 initializing Session。
5. 从 staging 分批 bootstrap，失败后复用各批 Idempotency-Key 重试。
6. 发送 expectedLogCount 激活。
7. 获取一次服务端规范快照，在本地安装 owner membership、shadow 和 highWatermark cursor，再重新叠加发布期间的 outbox。
8. 补拉快照之后的事件，刷新 outbox。
9. 连接 WS，进入 `ready`。

发布过程中不修改本地 `sessionId` 或 `syncId`。

### 16.2 加入

1. 用稳定 `joinRequestId` 兑换邀请码。
2. 检查本地是否已经绑定同一远端 Session。
3. 本地若存在未绑定的同 ID Session，停止并提示 `LOCAL_SESSION_ID_CONFLICT`，不能静默合并。
4. 下载完整快照到 staging。
5. 在单个 Rust SQLite 事务中安装 Session、Log、shadow、membership 和 highWatermark cursor。
6. 拉取快照之后的事件直到当前 head。
7. 获取 WS ticket，从当前 cursor 订阅。
8. 收到 `ready` 后进入协作界面。

邀请码兑换响应丢失时复用 joinRequestId。快照安装完成前不得提前推进 cursor，也不得覆盖用户当前可用 Session。

### 16.3 本地写入

一次 UI 修改对应一个 Rust SQLite 事务：

1. 校验本地 role 和 Session 状态。
2. 读取 shadow 的 baseVersion/baseJson 与 cursor。
3. 修改 materialized Session/Log，使 UI 立即可见。
4. 生成 mutationId 并写 outbox。
5. 提交事务后通知 Flutter。

Flutter 显示“已保存到本地”；只有规范事件确认后状态才变成“已同步”。

### 16.4 事件应用

REST accepted 事件、events API 和 WebSocket 事件全部进入同一个 Rust `applyEvent`：

1. `seq <= cursor`：重复；验证 eventId 后忽略。
2. `seq > cursor + 1`：缓存并触发补拉，不越序应用。
3. `seq == cursor + 1`：开启 SQLite 事务。
4. 更新 shadow。
5. 处理匹配 mutationId 的 outbox ACK。
6. 重新叠加同实体后续 pending patch，避免自己的 echo 覆盖新输入。
7. 处理远端并发修改或创建 conflict。
8. 写 applied_events。
9. 在同一事务中推进 cursor。
10. 提交后通知 Flutter。

REST 响应和 WS echo 到达顺序任意，最终都通过该应用器收敛。

### 16.5 重连

1. 确认当前 server/account 与 outbox 分区一致。
2. 刷新自己的 membership；若已被移除，进入 `revoked`，不再发送。
3. 从当前 cursor 调用 events API 追平远端。
4. 应用补拉事件。
5. 刷新无冲突 outbox。
6. 获取 ticket 并从最新 cursor 连接 WS。
7. 收到 `ready` 后进入 online。

退避使用 full jitter：约 1、2、4、8 秒递增，最大 60 秒；稳定在线 30 秒后清零。`Retry-After` 优先。

### 16.6 cursor 过期与重拉快照

收到 `CURSOR_EXPIRED` 时：

1. 保留 outbox 和 conflict。
2. 下载新快照到 staging。
3. 原子替换 shadow/canonical materialized 基线。
4. 在新基线上重新叠加 pending outbox。
5. 对已删除或版本不兼容的实体创建 conflict。
6. 把 cursor 设置为快照 highWatermark。
7. 再补事件、flush outbox、连接 WS。

重拉快照永远不能丢失本地待提交修改。

实施结果（2026-07-12）：REST 补拉返回 `CURSOR_EXPIRED` 或 WS 发出 `resyncRequired` 后，客户端会先刷新 membership，再请求 `includeDeleted=true` 快照；Rust 在单个事务内校验身份、成员版本、角色、快照标记和 head 单调性，替换规范 shadow/materialized 基线，同时保留并重放 outbox、conflict 与本地创建链。安装完成后 coordinator 按“补拉事件 → flush outbox → 重连 WS”恢复；旧账号、旧服务器或旧 Session 的异步回调受身份代次隔离，不能污染当前副本。

### 16.7 权限撤销、离开与 fork

- 收到 `accessRevoked` 后立即停止发送并关闭 WS。
- 本地 binding 进入 `revoked`，数据保持只读。
- 用户可以导出，或 fork 为新本地 Session；fork 必须生成新的 sessionId 和 Log syncId，避免以后误连旧远端。
- 主动离开由服务端先删除 membership，成功后执行相同本地流程。

## 17. 冲突 UI

冲突不能用连续弹窗打断点名录入：

- Session 顶部显示“待同步 X / 冲突 Y / 离线”等状态。
- Log 行显示 pending、retrying、conflict、rejected 图标。
- 统一“冲突中心”展示基础值、本地值、远端值、修改人和时间。
- 无冲突字段自动合并，只突出真正冲突字段。

操作：

- **采用远端**：取消对应 pending 链，用 shadow 重建 materialized row。
- **保留本地**：基于最新远端版本创建一个新的 mutation。
- **手动合并**：逐字段选择后，基于最新版本创建 mutation。
- **远端已删除**：接受删除，或“复制为新记录”；旧 update 不直接恢复。
- **权限撤销/Session 关闭**：导出或 fork，不再自动重试。

解决 mutation 被规范事件确认前，冲突状态为 `resolving`。期间又出现远端新版本时，按最新版本重新打开冲突。

实施结果（2026-07-12）：Rust 已对完整线性本地 mutation 链做三方比较；仅可编辑字段且互不重叠时，自动以新 mutationId 基于最新远端版本 rebase。生命周期变化、同字段分叉、同版本不同内容或不安全依赖进入持久 conflict，且对应实体在解决前冻结写入。冲突中心展示基线/本地/最新远端摘要，并严格使用 Rust 按最新角色、Session 状态和远端内容返回的允许操作：采用远端、保留本地重试，或把未删除的本地日志复制为新 UUID/base-0 create；远端 tombstone 上的旧 update 和 create ID 碰撞不会覆盖或复活原实体。远端实体、Session 状态、成员角色或快照基线变化会使列表失效并重拉；每次解决还携带用户实际确认的 `expectedRemoteVersion`，事务内版本已前进时三种操作均零写入拒绝，刷新后必须重新确认。高级逐字段手动合并与确认前的长期 `resolving` 展示仍待后续完善。

## 18. 公开 Liveshare

Liveshare 页面流程：

1. 从 URL fragment 取得 secret。
2. 交换短期公开 access token。
3. 获取公开快照并立即展示已有日志。
4. 使用 highWatermark 换取公开 WS ticket。
5. 通过同一 seq 规则应用后续 Log/Session 事件。
6. token 过期或被撤销时停止读取并显示明确状态。

公开 DTO 默认包含 Session 标题和 Log 业务字段，不包含：

- userId/accountId
- sourceDeviceId
- mutationId
- 邀请、成员和内部审计信息

页面设置 `Referrer-Policy: no-referrer`，不得把 secret 写入 localStorage、日志或错误上报。

## 19. 安全要求

- 生产启动必须要求显式强随机 `JWT_SECRET`，禁止 fallback 默认值。
- 手工邀请码使用独立强随机 `INVITE_HMAC_KEY`；不得复用或硬编码 JWT secret。
- Access token 必须过期，refresh token 轮换并可撤销。
- 首个 admin 不再由“公网第一个注册者”自动获得；使用部署期 bootstrap secret 或本地 CLI 初始化。
- REST、snapshot、events 和 WS 使用相同对象级 membership 检查，防止 IDOR。
- 登录、邀请码兑换、mutation、WS 建连和公开链接交换均限流。
- 校验 UUID、枚举、时间、角色、字段长度、批量条数和 body 大小。
- CORS 和 WebSocket Origin 使用 allowlist。
- 成员变化后立即关闭失去权限的连接。
- 邀请、公开 token、refresh token、WS ticket 只存 hash。
- 日志不得记录密码、长期 token、完整邀请码或公开 secret。
- 审计成员变化、所有权转移、邀请创建/兑换/撤销和 Session 删除；公开链接接入时必须补齐同等审计。

建议字段上限：

| 字段 | 最大长度 |
|---|---:|
| title | 200 |
| controller / callsign | 32 |
| rstSent / rstRcvd | 16 |
| qth / device / antenna | 200 |
| power / height | 64 |
| remarks | 2000 |

## 20. 数据迁移与兼容

### 20.1 服务端

1. 引入迁移 runner，并把当前 schema 作为基线。
2. 创建协作新表和索引。
3. 为每个现有 Session 的 `owner_user_id` 创建 owner membership。
4. 重建 logs 表，补 `remarks`、`version`、审计字段和复合唯一约束。
5. 处理已有重复 `(session_id, sync_id)`：相同内容保留一条；内容不同的额外行分配新 syncId 并写 migration audit，绝不静默丢行。
6. 旧 `shares` 语义与成员邀请不同，不自动升级为有效邀请；迁移后统一撤销，Owner 重新生成。
7. 迁移 v10 创建追加式 `collaboration_audit_events`、查询索引和防误改 trigger；无法可靠还原 requestId、mutationId 和操作时授权，因此不为升级前的历史状态猜测或回填审计事件。
8. 修复正式构建资产复制，并以空数据库和旧数据库各做一次启动测试。

### 20.2 客户端

1. Rust schema 升级，增加 binding/shadow/outbox/events/conflicts。
2. 本地 `sessions.share_code` 停止使用；邀请码只由服务端生成。
3. 为已存在 Log 保留当前 syncId、time 和备注等字段。
4. 当前未完成的 remarks 改动并入统一 Log DTO，不回退或覆盖。
5. 首次发布只绑定用户明确选择的 Session，不自动上传全部历史数据。
6. 下载/加入不再调用会重新生成 syncId/time 的普通 `addLog`，改用原子 snapshot installer。

### 20.3 API 迁移期

- 新服务端先上线 `/api/v1`，旧未版本化接口标记 deprecated。
- 新客户端只在 `server-info` 声明支持 protocol 1 时显示“开始协作”。
- 旧上传/下载入口从 UI 移除，避免同一 Session 同时走两个数据通道。
- 迁移期旧客户端仍可登录，但不能被误认为 v1 协作成员。

## 21. 测试策略

### 21.1 服务端

- migration：空数据库、当前旧 schema、重复 Log、失败回滚、checksum 变化。
- API contract：字段规范、错误 envelope、权限矩阵和状态转换。
- mutation：正常重试、并发重试、响应丢失重试、ID 复用不同 payload。
- transaction：实体和事件同生同灭，广播前提交。
- invite：并发兑换、响应丢失重试、过期、撤销、次数耗尽。
- WebSocket：鉴权、补 backlog、重复、断线、服务重启、成员移除。
- public live：快照、实时事件、撤销、字段裁剪。
- 正式 dist：空目录启动并成功创建完整 schema。

### 21.2 Rust 客户端

- 本地业务修改和 outbox 原子性。
- applyEvent 与 cursor 原子性。
- REST/WS echo 任意先后顺序。
- 重复、乱序、缺号事件。
- create/update/delete outbox 合并。
- 进程在发送前、发送中、HTTP accepted 后、事件应用中崩溃并恢复。
- snapshot 重装保留 pending。
- 账号/服务器切换隔离。
- 版本冲突、远端 delete、本地 delete 和 conflict 解决。

### 21.3 端到端

至少覆盖：

1. Owner 发布超过 500 条的 Session，字段和数量完整。
2. Editor 加入后保留相同 sessionId、syncId、time、RST 和 remarks。
3. Owner/Editor 同时新增不同 Log，双方和 Liveshare 收敛。
4. 两端同时修改同一版本，一个 accepted，一个得到稳定 conflict。
5. Viewer 的所有写操作均被拒绝。
6. REST 已提交但响应丢失，重试后数据库和事件仍只有一份。
7. 客户端断线期间发生增删改，按 cursor 完整补回。
8. 快照之后、WS ready 之前持续写入，无遗漏无重复。
9. 成员在线时被移除，连接立即关闭，后续所有访问拒绝。
10. Session 关闭期间的离线写入不被静默上传。
11. 服务重启发生在提交后、广播前，客户端重连后仍能补回事件。
12. 公开 Liveshare 打开即显示历史日志，撤销后停止访问。

最终验收不是“接口返回 200”，而是每个故障注入场景结束后：

- 服务端数据库状态正确；
- Session 事件序列连续；
- 所有在线客户端一致；
- 重启后的离线客户端最终与服务端收敛；
- 不出现重复 Log、丢字段或越权访问。

## 22. 分阶段实施

### 阶段 0：基础可靠性

- 服务端迁移 runner、schema 资产构建和正式 dist 启动测试。
- 统一错误处理、DTO 校验、字段命名和日志唯一约束。
- server-info、强制 secret、token 过期和基本限流。
- 为后续接口建立集成测试框架。

验收：空数据库和现有数据库都能用正式构建启动；`tsc`、API 测试和迁移测试通过。

### 阶段 1：发布、成员和快照

- 三阶段发布流程。
- session_members、collaboration_invites 和角色权限。
- 完整 snapshot。
- 客户端 binding、snapshot installer 和同 ID 加入。
- 移除旧上传/下载 UI 通道。

验收：两名用户绑定相同 sessionId，得到字段完整且一致的初始快照；Owner/Editor/Viewer 的邀请、快照和管理权限符合矩阵。

实施结果（2026-07-11）：服务端发布/bootstrap/activate/snapshot、成员、邀请、兑换和所有权接口已落地；客户端已接入 v1 认证、发布锁、本地 binding/shadow、同 ID 原子快照安装、成员/邀请页面和撤权处理。发布端会在首次远端请求前校验冻结快照，并按记录数与 UTF-8 body 字节数动态分批；激活响应丢失、认证上下文切换及成员管理响应丢失均通过远端状态探测、身份代次和持久幂等 ID 收敛。阶段 1 期间的绑定 Session 只读保护已在阶段 2 由基于角色和规范 Session 状态的写策略取代。

### 阶段 2：在线实时协作

- mutation processor、版本、seq 和 session_events。
- events API、WS ticket、catch-up/live 握手。
- Rust event applier 和 Dart coordinator。
- 公开 Liveshare 快照 + 实时事件（本轮明确延后，不复用旧通道）。

验收：在线 Owner/Editor/Viewer 和公开页面实时收敛，断开再连不丢事件。

实施结果（2026-07-12）：服务端迁移 v8、Log create/update/delete/restore、Session title/close/reopen/delete、严格 baseVersion、逐 operation 持久幂等结果、连续 session_events、分页补拉、60 秒单次 WS ticket，以及带 backlog/ready/live 握手的鉴权 WebSocket 已落地。Session 删除在一个事务中写 tombstone、撤销邀请和 WS ticket、生成唯一最终事件并保存幂等结果；提交后先广播 `session.deleted` 再关闭该 Session 的在线连接，删除时仍有效的成员可继续补拉终止事件。ticket 绑定签发角色/成员版本，backlog 和慢消费者缓冲有硬上限；成员角色变化会发送 control 后断开促使重连，成员移除会发送 accessRevoked 并立即关闭；Origin、建连速率和 Session/User/IP 连接数均有限制。客户端 schema v5 已实现业务写入与 outbox 同事务、原子 claim、同 mutationId 崩溃恢复、accepted 等待规范事件、严格连续 event apply、shadow/materialized/cursor 同事务、成员版本持久化，以及 REST catch-up + WS hint 的串行 coordinator。永久 rejected 保留可见草稿，并在同实体再次编辑时原子折叠旧链、基于规范 shadow 生成全新 mutationId。Owner/Editor 可写，Viewer、撤权成员和规范 closed/deleted Session 强制只读。当前进程内 hub 要求单 Node 实例部署；公开 Liveshare 明确延后，不复用已禁用的旧 share/WS 通道。

### 阶段 3：离线、重试和冲突

- 已完成：durable outbox 状态机、请求批处理、崩溃恢复、shadow、冲突持久化和账号/服务器切换隔离。
- 已完成：保留 pending mutation/conflict 的 `CURSOR_EXPIRED` tombstone 快照原子重装与自动恢复流程。
- 已完成：完整本地 mutation 链的安全三方 rebase、冲突实体写冻结，以及采用远端/保留本地/复制为新日志的冲突中心 MVP。
- 待完善：高级逐字段手动合并，以及 replacement mutation 得到规范事件确认前的长期 `resolving` 展示。

验收：故障注入和离线冲突用例全部通过。

### 阶段 4：安全与运维完善

- 已完成：Refresh token 轮换、成员 WS ticket、Origin/CORS allowlist，以及连接/邀请码/写入限流。
- 已完成：Owner-only 协作安全审计，覆盖成员、所有权、邀请和 Session 删除，并通过 `collaborationSecurityAudit` capability 协商。
- 待完成：公开 ticket、公开链接审计和跨实例实时 pub/sub。
- 事件保留和裁剪策略。
- 请求、mutation、event、outbox、重连指标。

## 23. 必须保持的不变量

实现和评审时以以下不变量为准：

1. UI 收到“本地保存成功”前，业务数据和 outbox 已在同一事务持久化。
2. cursor 前进前，对应规范事件的全部影响已在同一事务落库。
3. mutation 重试永远不更换 mutationId。
4. 规范事件应用前不删除 outbox。
5. 一个 Session 只有一个串行事件应用器。
6. 检测到 seq 缺口时绝不越序应用。
7. 状态修改和事件落库在同一服务端事务。
8. 事务提交前绝不广播。
9. 冲突只暂停单个实体链，不暂停事件流或整个 Session。
10. 重拉快照不得丢失 pending mutation。
11. 切换 server/account 后旧 outbox 绝不发送。
12. 删除胜过基于旧版本的 update；恢复必须显式执行。
13. 任何客户端时间都不参与版本、权限、过期或冲突排序。
14. 任意崩溃点重启后，客户端都能依靠 snapshot、cursor 和 outbox 收敛。

## 24. 后续可选能力

以下能力不阻塞 v1：

- 成员显示名、在线状态和“谁正在录入”的 presence。
- 邀请二维码。
- Owner 转让之外的多 owner。
- 大型 Session 的不可变分页 snapshot。
- 事件压缩与定期 checkpoint。
- 按字段配置公开 Liveshare 可见内容。
- 服务端集群和外部消息总线。
- 更细粒度的字段级自动合并策略。

这些能力必须建立在 v1 的 ID、version、seq、mutation 和权限模型上，不另建第二套同步协议。
