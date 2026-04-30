# OpenLogTool Session / History 统一模型设计文档（真实字段版 v5）

## 1. 目标

本文档用于规范 OpenLogTool 后续的 session、history、logs 与同步协议。

本版示例按当前仓库真实字段风格编写：

- 日志主键/同步标识：`sync_id`
- session 批次标识：`session_id`
- 日志业务字段：`time`、`controller`、`callsign`、`report`、`qth`、`device`、`power`、`antenna`、`height`
- 同步字段：`created_at`、`updated_at`、`deleted_at`、`source_device_id`
- 字典同步结构：`dictionaries.rigs`、`dictionaries.antennas`、`dictionaries.qths`、`dictionaries.callsigns`

核心结论：

> `session` 表示一整次总记录；`active session` 是当前记录；`closed / archived session` 是历史记录；`logs` 是某个 session 下的明细。

---

## 2. 正确模型

```text
sessions
  ├── session A status=closed
  │     ├── log 1
  │     ├── log 2
  │     └── log 3
  │
  ├── session B status=closed
  │     ├── log 1
  │     └── log 2
  │
  └── session C status=active
        ├── log 1
        └── log 2
```

错误模型：

```text
session
  ├── logs
  └── history   ❌
```

`history` 不应该作为 session 的子表。  
在当前业务里，`history` 本质上就是旧的 session。

---

## 3. ID 设计

### 3.1 client_instance_id / source_device_id

客户端首次启动或首次初始化数据库时，应自动生成本地安装实例 ID。

第一版为了贴合现有仓库字段，可以继续落到：

```text
source_device_id = client_instance_id
deviceId = client_instance_id
```

示例：

```text
c6f3e9a7b8d94a2fa11c3e5d61f90a42
```

要求：

- 自动生成
- 本地持久化
- 不依赖服务端
- 不要求用户配置
- App 重启后保持不变
- 重新安装或清除数据后可以变化

### 3.2 session_id

`session_id` 表示一整次总记录。

生成规则：

```text
session_id = sha256(client_instance_id + ":" + timestamp + ":" + random).substring(0, 32)
```

注意：

```text
32 个 hex 字符 = 128 bit
```

不要写成“前 32 bit”，因为 32 bit 只有 8 个 hex 字符。

示例：

```text
9f8c2a7d4e12bb9010d3c4a88f91e2b7
```

### 3.3 sync_id

`sync_id` 仍然保留，用于标识单条日志。

区别：

```text
session_id = 一整次总记录
sync_id = 一条日志
```

`sync_id` 的作用：

- upsert 单条 log
- 删除单条 log
- 避免重复插入
- 多端同步时识别同一条日志

---

## 4. sessions 数据结构

### 4.1 表结构建议

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

字段说明：

| 字段 | 说明 |
|---|---|
| `session_id` | 一整次总记录 ID |
| `title` | session name / 记录名称 / live share 标题 |
| `status` | `active` / `closed` / `archived` |
| `created_at` | 创建时间 |
| `updated_at` | 最后更新时间 |
| `closed_at` | 关闭时间 |
| `deleted_at` | 软删除时间 |
| `source_device_id` | 创建或最后修改来源客户端实例 |

### 4.2 active session 示例

```json
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
```

### 4.3 closed session 示例

```json
{
  "session_id": "9f8c2a7d4e12bb9010d3c4a88f91e2b7",
  "title": "2026-04-30 晚间点名",
  "status": "closed",
  "created_at": "2026-04-30T12:30:00.000Z",
  "updated_at": "2026-04-30T13:30:00.000Z",
  "closed_at": "2026-04-30T13:30:00.000Z",
  "deleted_at": null,
  "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42"
}
```

---

## 5. logs 数据结构

### 5.1 logs 表增加 session_id

```sql
ALTER TABLE logs ADD COLUMN session_id TEXT;
```

推荐索引：

```sql
CREATE INDEX idx_logs_session_id ON logs(session_id);
CREATE INDEX idx_logs_session_updated ON logs(session_id, updated_at);
CREATE INDEX idx_logs_sync_id ON logs(sync_id);
```

### 5.2 log 示例

```json
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
```

### 5.3 软删除示例

```json
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
  "updated_at": "2026-04-30T12:45:00.000Z",
  "deleted_at": "2026-04-30T12:45:00.000Z",
  "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42"
}
```

---

## 6. 创建 session 时输入 session name

创建 session 时由用户输入本次记录名称。

落库字段：

```text
title
```

UI 可显示为：

```text
Session Name
记录名称
本次记录名称
```

规则：

| 场景 | 规则 |
|---|---|
| 用户输入了名称 | 使用用户输入作为 `sessions.title` |
| 用户未输入名称 | 自动生成默认 title |
| 修改名称 | 更新 `sessions.title` 和 `updated_at` |
| live share 页面 | 使用 `session.title` 作为页面标题 |

默认 title 示例：

```text
2026-04-30 晚间点名
```

---

## 7. 当前记录与历史记录

### 7.1 查询当前记录

```sql
SELECT *
FROM logs
WHERE session_id = ?
  AND deleted_at IS NULL
ORDER BY created_at ASC;
```

`session_id` 来自：

```text
current_session_id
```

### 7.2 查询历史列表

历史记录就是 closed / archived sessions：

```sql
SELECT *
FROM sessions
WHERE status IN ('closed', 'archived')
  AND deleted_at IS NULL
ORDER BY created_at DESC;
```

### 7.3 打开历史记录

```sql
SELECT *
FROM logs
WHERE session_id = ?
ORDER BY created_at ASC;
```

---

## 8. 清空并开始新记录

“清空当前总记录”不应直接删除 logs。

正确流程：

```text
1. 将当前 session 标记为 closed
2. 设置 closed_at
3. 生成新的 session_id
4. 用户输入新的 session title
5. 插入新的 active session
6. 更新 current_session_id
7. 当前页面切换到新 session
```

也就是说：

```text
清空当前记录 ≠ 删除旧 logs
清空当前记录 = 关闭旧 session + 创建新 session
```

---

## 9. 同步协议

### 9.1 bidirectional 请求示例

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

### 9.2 bidirectional 响应示例

```json
{
  "ok": true,
  "serverTime": "2026-04-30T12:31:05.000Z",
  "summary": {
    "received": {
      "sessions": 1,
      "logs": 1,
      "dictionaries": 0,
      "callsignQthHistory": 0
    },
    "applied": {
      "sessions": 1,
      "logs": 1,
      "dictionaries": 0,
      "callsignQthHistory": 0
    },
    "ignored": {
      "sessions": 0,
      "logs": 0,
      "dictionaries": 0,
      "callsignQthHistory": 0
    },
    "conflicts": 0
  },
  "changes": {
    "sessions": [],
    "logs": [],
    "dictionaries": {
      "rigs": [],
      "antennas": [],
      "qths": [],
      "callsigns": []
    },
    "callsignQthHistory": []
  },
  "nextSyncToken": {
    "lastSyncAt": "2026-04-30T12:31:05.000Z"
  }
}
```

---

## 10. history 兼容迁移

如果当前已有 `history` 表，并且它表示旧的完整总记录：

```text
旧 history 行 = 旧 session
```

迁移时不要把它作为 session 子表。

应迁移为：

```text
history -> sessions
```

迁移规则：

1. 为每条旧 history 生成或保留 `session_id`
2. 将旧 history 的名称、创建时间、更新时间迁移到 `sessions`
3. 设置 `status = closed`
4. 将对应 logs 绑定到该 `session_id`
5. 新协议中不再新增 `payload.history`

如需兼容旧 API，可以让服务端收到 `payload.history` 后转换为 `sessions` 处理。

---

## 11. 冲突规则

### 11.1 sessions 冲突

| 场景 | 规则 |
|---|---|
| 服务端无 session，客户端上传 | 插入 |
| 服务端有 session，客户端更新 | 比较 `updated_at` |
| 修改 vs 修改 | `updated_at` 新者胜 |
| 删除 vs 修改 | 删除优先 |
| active vs closed | `updated_at` 新者胜 |
| 时间相同 | 服务端胜 |

### 11.2 logs 冲突

| 场景 | 规则 |
|---|---|
| 服务端无 log，客户端上传 | 插入 |
| 服务端有 log，客户端更新 | 比较 `updated_at` |
| 修改 vs 修改 | `updated_at` 新者胜 |
| 删除 vs 修改 | 删除优先 |
| 时间相同 | 服务端胜 |
| `session_id` 不同 | 不应修改；视为异常或拒绝 |

---

## 12. 服务端处理顺序

```text
1. 校验 token / deviceId / payload
2. 处理 payload.sessions
3. 处理 payload.logs
4. 处理 dictionaries
5. 处理 callsignQthHistory
6. 记录 sync summary
7. 查询远端 changes
8. 返回响应
```

必须先处理 sessions，再处理 logs，因为 logs 依赖 `session_id`。

---

## 13. 客户端改动清单

- [ ] 增加 `client_instance_id` 自动生成和持久化
- [ ] 增加 `session_id` 生成器
- [ ] 增加 `sessions` 表
- [ ] 创建 session 时输入 `title`
- [ ] 保存 `current_session_id`
- [ ] logs 表增加 `session_id`
- [ ] 新增 log 时自动写入当前 `session_id`
- [ ] 清空逻辑改为 `startNewSession`
- [ ] 历史页面读取 closed sessions
- [ ] 旧 history 迁移为 sessions
- [ ] 同步 payload 增加 `sessions`

---

## 14. 服务端改动清单

- [ ] 增加 SessionModel
- [ ] 增加 SessionRepository
- [ ] 增加 sessions 表
- [ ] SyncService 支持 `payload.sessions`
- [ ] SyncService 先处理 sessions，再处理 logs
- [ ] `changes` 返回 sessions + logs
- [ ] 增加 sessions 查询接口
- [ ] `/history` 如保留，应映射到 closed sessions
- [ ] live share 页面使用 `session.title` 作为标题

---

## 15. 最终结论

OpenLogTool 应使用：

```text
sessions + logs
```

来统一表达当前记录与历史记录。

最终语义：

```text
session = 一整次总记录
active session = 当前记录
closed session = 历史记录
logs = session 下的明细
```

日志字段保持当前真实结构：

```text
sync_id
session_id
time
controller
callsign
report
qth
device
power
antenna
height
created_at
updated_at
deleted_at
source_device_id
```
