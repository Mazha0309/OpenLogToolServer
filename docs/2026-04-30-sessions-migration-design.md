# OpenLogTool Sessions 迁移设计文档

> 基于 [SESSION_HISTORY_UNIFIED_REAL_SCHEMA_v5.md](./OpenLogTool_SESSION_HISTORY_UNIFIED_REAL_SCHEMA_v5.md)
> 同步协议基于 [SYNC_PROTOCOL_v1.md](./OpenLogTool_SYNC_PROTOCOL_v1.md)

## 1. 目标

将当前 `logs + history（JSON快照）` 模型重构为 `sessions + logs（session_id关联）` 模型。

核心语义：
- `session` = 一整次总记录
- `active session` = 当前正在记录
- `closed session` = 历史记录
- `logs` = 某个 session 下的明细

## 2. 迁移策略

**彻底迁移（Clean Break）**：新建 sessions 表，logs 增加 session_id 关联。旧 history 数据做一次性迁移脚本转为 sessions，不保留向后兼容。

## 3. 新增数据模型

### 3.1 sessions 表

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  deleted_at TEXT,
  source_device_id TEXT
);
```

| 字段 | 说明 |
|------|------|
| `session_id` | sha256(clientInstanceId + ":" + timestamp + ":" + random).substring(0, 32) — 128 bit |
| `title` | 会话名称。用户输入或自动生成（如 "2026-04-30 晚间点名"） |
| `status` | `active` / `closed` / `archived` |
| `created_at` | 创建时间 UTC ISO8601 |
| `updated_at` | 最后更新时间 |
| `closed_at` | 关闭时间 |
| `deleted_at` | 软删除时间 |
| `source_device_id` | 创建来源设备 |

### 3.2 logs 表增加 session_id

```sql
ALTER TABLE logs ADD COLUMN session_id TEXT;
CREATE INDEX idx_logs_session_id ON logs(session_id);
CREATE INDEX idx_logs_session_updated ON logs(session_id, updated_at);
```

### 3.3 client_instance_id

客户端首次启动时自动生成 UUID，本地持久化，重启后不变。重装或清除数据后可变。

**与 deviceId 的关系**：`client_instance_id` 是新增的独立概念，不与现有的用户可配置 `deviceId` 冲突。
- `deviceId`：保持不变，用于同步 envelope 中标识设备，用户可配置
- `client_instance_id`：新增，用于 session 范围界定和跨设备 session 去重
- `source_device_id`：使用 envelope 中的 `deviceId`（保持现有行为不变）

双向同步请求 envelope 同时发送两者：
```json
{
  "deviceId": "BG5CRL-iPhone",
  "clientInstanceId": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
  "currentSessionId": "9f8c2a7d4e12bb9010d3c4a88f91e2b7",
  ...
}
```

## 4. 同步协议变更

### 4.1 bidirectional 请求增加 sessions

```json
{
  "deviceId": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
  "clientInstanceId": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
  "currentSessionId": "9f8c2a7d4e12bb9010d3c4a88f91e2b7",
  "lastSyncAt": "2026-04-30T12:00:00.000Z",
  "payload": {
    "sessions": [
      {
        "session_id": "9f8c2a7d4e12bb9010d3c4a88f91e2b7",
        "title": "2026-04-30 晚间点名",
        "status": "active",
        "created_at": "2026-04-30T12:30:00.000Z",
        "updated_at": "2026-04-30T12:30:00.000Z",
        "closed_at": null,
        "deleted_at": null,
        "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42"
      }
    ],
    "logs": [
      {
        "sync_id": "log-1770000000000000-a1b2c3d4e5f60708",
        "session_id": "9f8c2a7d4e12bb9010d3c4a88f91e2b7",
        "time": "20:30",
        "controller": "BG5CRL",
        "callsign": "BH1ABC",
        "report": "59",
        "qth": "Singapore",
        "device": "FT-70D",
        "power": "5W",
        "antenna": "NR-770H",
        "height": "1.5m",
        "created_at": "2026-04-30T12:31:00.000Z",
        "updated_at": "2026-04-30T12:31:00.000Z",
        "deleted_at": null,
        "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42"
      }
    ],
    "dictionaries": {
      "rigs": [],
      "antennas": [],
      "qths": [],
      "callsigns": []
    },
    "callsignQthHistory": []
  }
}
```

**注意：payload 中移除 `history` 字段。**

### 4.2 bidirectional 响应增加 sessions

```json
{
  "ok": true,
  "serverTime": "2026-04-30T12:31:05.000Z",
  "summary": {
    "received": { "sessions": 1, "logs": 1, "dictionaries": 0, "callsignQthHistory": 0 },
    "applied": { "sessions": 1, "logs": 1, "dictionaries": 0, "callsignQthHistory": 0 },
    "ignored": { "sessions": 0, "logs": 0, "dictionaries": 0, "callsignQthHistory": 0 },
    "conflicts": 0
  },
  "changes": {
    "sessions": [],
    "logs": [],
    "dictionaries": { "rigs": [], "antennas": [], "qths": [], "callsigns": [] },
    "callsignQthHistory": []
  },
  "nextSyncToken": {
    "lastSyncAt": "2026-04-30T12:31:05.000Z"
  }
}
```

### 4.3 服务端处理顺序

```
1. 校验 token / deviceId / payload
2. 处理 payload.sessions     ← 必须先于 logs
3. 处理 payload.logs          ← 依赖 session_id
4. 处理 dictionaries
5. 处理 callsignQthHistory
6. 记录 sync summary
7. 查询远端 changes
8. 返回响应
```

## 5. 冲突规则

沿用 SYNC_PROTOCOL_v1.md §8 的 LWW 规则：

| 场景 | 规则 |
|------|------|
| 服务端无记录，客户端上传 | 插入 |
| 修改 vs 修改 | `updated_at` 新者胜 |
| 删除 vs 修改 | 删除优先 |
| 时间相同 | 服务端胜 |

sessions 冲突额外规则：`session_id` 为不可变主键，不应修改。

### 5.1 孤儿日志处理

日志的 `session_id` 指向服务端不存在的 session 时，服务端**不应拒绝**，而应接受该日志。可能的原因：
- 日志先于 session 到达（同步顺序问题）
- 服务端和客户端对历史迁移的 session_id 不同

客户端在上传日志前必须确保对应的 session 已在 payload.sessions 中（或已在上次同步中上传）。

### 5.2 Push 端点

`POST /api/v1/logs/sync/push` 同样支持 `payload.sessions`。处理顺序同 bidirectional：先 sessions 后 logs。

### 5.3 current_session_id 语义

`current_session_id` 是客户端本地概念，不在设备间同步。服务端可以存储多个 active session（每个来自不同设备），但不对 current_session_id 做全局仲裁。

## 6. 客户端行为变更

| 操作 | 旧行为 | 新行为 |
|------|--------|--------|
| 首次启动 | 无 | 生成 `client_instance_id` 并持久化 |
| 新日志 | 直接 insert | insert 自动写入 `current_session_id` |
| 清空当前记录 | 创建 history JSON 快照 + 软删除全部 logs | 关闭当前 session → 创建新 session → 日志保留 |
| 查看历史 | 读取 `history` 表 | 查询 `sessions WHERE status='closed'` |
| 打开历史记录 | 从 JSON 快照恢复 logs | 查询 `logs WHERE session_id=?` |

### 清空当前记录流程

```
1. 将当前 session 标记为 closed
2. 设置 closed_at
3. 生成新的 session_id
4. 用户输入新的 session title
5. 插入新的 active session
6. 更新 current_session_id
7. 当前页面切换到新 session
```

## 7. 旧数据迁移

### 7.1 迁移策略

**服务端先行**：先在服务端完成 history → sessions 迁移，客户端通过同步获取 sessions。避免两端独立迁移产生重复数据。

### 7.2 session_id 生成（确定性）

为防止客户端和服务端生成不同的 session_id，迁移时使用**确定性生成**：

```
session_id = sha256("history-migration:" + old_history_sync_id).substring(0, 32)
```

不是随机的，同一个 `history.sync_id` 在任何设备上迁移结果相同。

### 7.3 迁移步骤

1. 服务端扫描 `history` 表
2. 对每条 history 记录：
   - 生成确定性 `session_id`
   - 将 `history.name` 映射为 `sessions.title`
   - `status` 设为 `closed`
   - `closed_at` 设为 `history.created_at` 或当前时间
   - 如果 history.logs_data 中的日志在 logs 表中存在，将其 `session_id` 更新为该 session
3. 将 history 行标记为已迁移（添加 `migrated_to_session_id` 列），**不删除**
4. 客户端通过同步拉取 sessions
5. 客户端本地执行相同的确定性迁移（从 history → sessions）
6. 旧 `history` 表保留，Phase 3 清理

## 8. 实现清单

### 服务端
- [ ] `src/models/session.js` — Session 模型
- [ ] `src/database/repository.js` — SessionRepository
- [ ] 适配器 sessions 表 / CRUD 方法
- [ ] `src/services/index.js` — SyncService 支持 payload.sessions，先 sessions 后 logs
- [ ] `changes` 返回 sessions + logs
- [ ] sessions 查询接口（可选）
- [ ] `/history` 如保留映射到 closed sessions

### 客户端
- [ ] `client_instance_id` 自动生成和持久化
- [ ] `session_id` 生成器
- [ ] `sessions` 表 + Session 模型
- [ ] 创建 session 时输入 title
- [ ] `current_session_id` 状态管理
- [ ] `logs` 表增加 `session_id` 列
- [ ] 新增 log 自动写入 `current_session_id`
- [ ] `clearAllLogs` → `startNewSession` 逻辑
- [ ] 历史页面读取 closed sessions
- [ ] 旧 history 迁转为 sessions
- [ ] 同步 payload 增加 `sessions`，移除 `history`

## 9. 范围外（本次不做）

- 字段级精细 merge
- 实时双向流同步
- OT / CRDT 冲突解决
- changeId 游标升级（v2 规划）
- Live Share 协同编辑
