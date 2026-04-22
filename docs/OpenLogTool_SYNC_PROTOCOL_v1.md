# OpenLogTool 同步协议与客户端/服务端对齐设计文档（v1）

## 1. 文档目的

本文档用于统一 OpenLogTool 客户端与服务端在“数据库同步”场景下的设计与实现，明确以下内容：

- 同步目标与边界
- 客户端与服务端的数据字段约定
- 冲突处理规则
- 删除策略
- 增量同步协议
- 接口请求与响应示例
- 服务端实现建议
- 客户端实现建议
- 测试与推进计划

本文档面向：

- 客户端开发
- 服务端开发
- 同步协议维护
- 问题排查与后续扩展

---

## 2. 设计目标

当前系统的同步目标不是“多人实时协同编辑”，而是：

> 以客户端本地数据库为主，服务端作为同步中枢与远端权威副本，实现多设备之间的数据交换、合并、传播与恢复。

### 2.1 当前目标
- 首次同步为全量同步
- 后续同步为增量同步
- 删除采用软删除
- 冲突按最后更新时间处理
- 每次同步都支持合并远端与本地变更
- 同步过程应尽量幂等、可重复执行、可调试

### 2.2 非目标（当前阶段不做）
- 字段级精细 merge
- 实时双向流同步
- 多用户复杂协同冲突编辑
- 自动处理非常复杂的并发改动
- 基于 OT / CRDT 的高级冲突解决

---

## 3. 总体架构

## 3.1 同步角色

### 客户端
负责：
- 保存本地 SQLite 数据
- 记录本地变更
- 发起同步
- 应用服务端返回的变更
- 保存同步游标

### 服务端
负责：
- 接收客户端上传的增量
- 保存远端权威副本
- 按规则合并冲突
- 返回客户端缺失的增量
- 记录同步日志

---

## 4. 同步模型概述

当前推荐采用：

- 首次同步：全量拉取或全量对齐
- 后续同步：`push -> merge -> pull`
- 删除：软删除
- 冲突规则：Last Write Wins（LWW）
- 冲突判断粒度：记录级
- 同步游标：当前先用 `lastSyncAt`，后续建议升级为 `changeId`

---

## 5. 数据对象范围

当前同步对象建议统一纳入协议管理：

- `logs`
- `dictionaries`
- `history`
- `callsignQthHistory`

服务端与客户端对这些对象的同步规则必须保持一致。

---

## 6. 通用字段约定

所有参与同步的记录都应尽可能具备以下字段。

## 6.1 基础同步字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `sync_id` | string | 是 | 全局唯一标识，同一条业务记录在多端同步时保持不变 |
| `created_at` | string(ISO8601) | 是 | 创建时间，UTC |
| `updated_at` | string(ISO8601) | 是 | 最后业务修改时间，UTC |
| `deleted_at` | string(ISO8601) / null | 否 | 软删除时间，非空表示已删除 |
| `source_device_id` | string | 推荐 | 最后一次修改来源设备 |
| `user_id` | string / int | 视情况 | 服务端用户归属 |
| `client_updated_at` | string(ISO8601) | 推荐 | 客户端产生的修改时间 |
| `server_updated_at` | string(ISO8601) | 推荐 | 服务端接收/确认变更时间 |

## 6.2 字段要求

### 时间格式
必须统一使用 UTC ISO8601，例如：

```json
"2026-04-21T14:30:12.123Z"
```

### 唯一标识
`sync_id` 必须全局唯一，推荐 UUID。

### 删除策略
删除不得直接物理删除同步对象，必须改为：

- 设置 `deleted_at`
- 保留原记录
- 让删除状态参与同步传播

---

## 7. 当前主要风险与对齐重点

## 7.1 风险一：过度信任客户端时间

如果服务端完全信任客户端上传的 `updated_at`，会出现：

- 设备时间漂移
- 用户手动改系统时间
- 时区问题
- 离线修改后顺序判断错误

### 建议
服务端保存两套时间：

```json
{
  "clientUpdatedAt": "2026-04-21T10:00:00.000Z",
  "serverUpdatedAt": "2026-04-21T10:00:03.125Z"
}
```

### v1 规则建议
当前阶段：
- 冲突比较仍可先基于 `updated_at`
- 但服务端必须额外记录 `server_updated_at`
- 后续排障、排序、变更日志应优先依赖服务端时间

---

## 7.2 风险二：增量同步只靠时间戳

当前若只使用：

```text
since=2026-04-21T10:00:00.000Z
```

会存在：
- 同一毫秒多条变更
- 边界重复
- 边界遗漏
- 精度依赖强

### v1 允许
先继续使用 `lastSyncAt`

### v2 建议
增加递增游标：

- `change_id`
- 或 `revision`

例如：

```json
{
  "nextSyncToken": {
    "lastSyncAt": "2026-04-21T10:00:03.125Z",
    "lastChangeId": 1287
  }
}
```

---

## 7.3 风险三：合并语义不够明确

当前“会合并”这句话容易产生歧义。

需要明确：

### 当前 v1 合并定义
- 合并粒度：记录级
- 不做字段级 merge
- 同一条记录冲突时直接选择胜出版本
- 删除优先级高于修改

---

## 8. 冲突处理规则（必须统一）

本节是客户端与服务端必须完全一致的核心规则。

## 8.1 规则总表

| 场景 | 规则 |
|------|------|
| 本地无记录，远端有记录 | 插入远端记录 |
| 远端无记录，本地上传记录 | 插入本地记录 |
| 修改 vs 修改 | 取 `updated_at` 更晚者 |
| 删除 vs 修改 | 删除优先 |
| 删除 vs 删除 | 保持删除 |
| 时间相同但内容不同 | 进入固定兜底规则 |
| 重复接收同一条记录 | 幂等，不应产生副作用 |

## 8.2 时间相同时的兜底规则
建议固定如下：

1. 若一方 `deleted_at` 非空，删除胜
2. 若都未删除，则优先保留服务端版本
3. 记录冲突日志，便于后续排查

> 原因：第一版不要让客户端和服务端各自做不同的“猜测性合并”。

## 8.3 删除优先
必须明确写死：

> 只要进入“删除 vs 修改”的冲突场景，删除优先。

这样做的原因：
- 删除是显式动作
- 更安全
- 可避免已删除对象被旧修改“复活”

---

## 9. 同步流程设计

## 9.1 首次同步

### 目标
让新客户端快速获得服务端完整数据副本。

### 建议流程
1. 客户端完成登录/鉴权
2. 客户端判断本地无同步基线
3. 客户端发起首次同步请求
4. 服务端返回全量数据
5. 客户端写入本地数据库
6. 客户端保存同步游标

### 首次同步标识建议
客户端可通过以下任一条件判断：
- 本地 `lastSyncAt == null`
- 本地 `lastSyncChangeId == null`
- 本地记录数量为 0 且配置中无同步状态

---

## 9.2 后续双向同步

推荐流程：

```text
客户端收集本地增量
    ↓
POST /sync/bidirectional
    ↓
服务端处理本地增量并合并
    ↓
服务端返回客户端缺失的远端增量
    ↓
客户端应用远端变更
    ↓
客户端更新同步游标
```

---

## 10. API 设计建议

以下为推荐的协议设计，命名可按现有项目适配。

# 10.1 Bidirectional Sync

## 接口
```http
POST /api/v1/logs/sync/bidirectional
Content-Type: application/json
Authorization: Bearer <token>
```

## 请求体示例
```json
{
  "deviceId": "device_android_001",
  "lastSyncAt": "2026-04-21T09:00:00.000Z",
  "payload": {
    "logs": [
      {
        "sync_id": "4a68f18f-7f3e-4d95-a4cf-0001",
        "created_at": "2026-04-20T11:00:00.000Z",
        "updated_at": "2026-04-21T09:10:00.000Z",
        "deleted_at": null,
        "source_device_id": "device_android_001",
        "callsign": "BG5CRL",
        "band": "UHF",
        "mode": "FM",
        "note": "updated by mobile"
      },
      {
        "sync_id": "4a68f18f-7f3e-4d95-a4cf-0002",
        "created_at": "2026-04-20T12:00:00.000Z",
        "updated_at": "2026-04-21T09:11:00.000Z",
        "deleted_at": "2026-04-21T09:11:00.000Z",
        "source_device_id": "device_android_001",
        "callsign": "TEST1",
        "band": "VHF",
        "mode": "FM"
      }
    ],
    "dictionaries": {
      "bands": [
        {
          "sync_id": "dict-band-001",
          "created_at": "2026-04-19T10:00:00.000Z",
          "updated_at": "2026-04-21T08:00:00.000Z",
          "deleted_at": null,
          "source_device_id": "device_android_001",
          "name": "UHF",
          "sort_order": 1
        }
      ],
      "modes": [],
      "rigs": [],
      "antennas": []
    },
    "history": [],
    "callsignQthHistory": []
  }
}
```

## 响应体示例
```json
{
  "ok": true,
  "serverTime": "2026-04-21T09:10:03.125Z",
  "summary": {
    "received": {
      "logs": 2,
      "dictionaries": 1,
      "history": 0,
      "callsignQthHistory": 0
    },
    "applied": {
      "logs": 2,
      "dictionaries": 1,
      "history": 0,
      "callsignQthHistory": 0
    },
    "ignored": {
      "logs": 0,
      "dictionaries": 0,
      "history": 0,
      "callsignQthHistory": 0
    },
    "conflicts": 0
  },
  "changes": {
    "logs": [
      {
        "sync_id": "4a68f18f-7f3e-4d95-a4cf-0099",
        "created_at": "2026-04-20T14:00:00.000Z",
        "updated_at": "2026-04-21T09:05:00.000Z",
        "deleted_at": null,
        "source_device_id": "device_web_001",
        "callsign": "BD1XYZ",
        "band": "UHF",
        "mode": "FM",
        "note": "created on another device"
      }
    ],
    "dictionaries": {
      "bands": [],
      "modes": [],
      "rigs": [],
      "antennas": []
    },
    "history": [],
    "callsignQthHistory": []
  },
  "nextSyncToken": {
    "lastSyncAt": "2026-04-21T09:10:03.125Z"
  }
}
```

---

# 10.2 Push Sync

## 接口
```http
POST /api/v1/logs/sync/push
Content-Type: application/json
Authorization: Bearer <token>
```

## 请求体示例
```json
{
  "deviceId": "device_android_001",
  "payload": {
    "logs": [
      {
        "sync_id": "4a68f18f-7f3e-4d95-a4cf-0003",
        "created_at": "2026-04-21T09:00:00.000Z",
        "updated_at": "2026-04-21T09:20:00.000Z",
        "deleted_at": null,
        "source_device_id": "device_android_001",
        "callsign": "BH1ABC",
        "band": "HF",
        "mode": "SSB"
      }
    ]
  }
}
```

## 响应体示例
```json
{
  "ok": true,
  "serverTime": "2026-04-21T09:20:02.500Z",
  "summary": {
    "received": 1,
    "applied": 1,
    "ignored": 0,
    "conflicts": 0
  }
}
```

---

# 10.3 Pull Sync

## 接口
```http
GET /api/v1/logs/sync/pull?since=2026-04-21T09:00:00.000Z
Authorization: Bearer <token>
```

## 响应体示例
```json
{
  "ok": true,
  "serverTime": "2026-04-21T09:30:01.000Z",
  "changes": {
    "logs": [
      {
        "sync_id": "4a68f18f-7f3e-4d95-a4cf-0088",
        "created_at": "2026-04-20T18:00:00.000Z",
        "updated_at": "2026-04-21T09:25:00.000Z",
        "deleted_at": null,
        "source_device_id": "device_web_001",
        "callsign": "BG8ZZZ",
        "band": "VHF",
        "mode": "FM"
      }
    ],
    "dictionaries": {
      "bands": [],
      "modes": [],
      "rigs": [],
      "antennas": []
    },
    "history": [],
    "callsignQthHistory": []
  },
  "nextSyncToken": {
    "lastSyncAt": "2026-04-21T09:30:01.000Z"
  }
}
```

---

## 11. 错误码与错误响应建议

## 11.1 通用错误响应格式
```json
{
  "ok": false,
  "error": {
    "code": "SYNC_INVALID_PAYLOAD",
    "message": "payload.logs must be an array"
  }
}
```

## 11.2 推荐错误码

| 错误码 | 含义 |
|------|------|
| `SYNC_INVALID_PAYLOAD` | 请求体格式错误 |
| `SYNC_UNAUTHORIZED` | 未登录或 token 无效 |
| `SYNC_INVALID_TIMESTAMP` | 时间字段格式错误 |
| `SYNC_DEVICE_ID_REQUIRED` | 缺少 deviceId |
| `SYNC_CONFLICT_UNRESOLVED` | 服务端无法自动处理冲突 |
| `SYNC_INTERNAL_ERROR` | 服务端内部错误 |

---

## 12. 服务端实现建议

## 12.1 Upsert 核心伪代码

```js
function applyIncomingRecord(local, incoming) {
  if (!local) {
    return { action: "insert", record: incoming };
  }

  const localDeleted = !!local.deleted_at;
  const incomingDeleted = !!incoming.deleted_at;

  if (incomingDeleted && !localDeleted) {
    return { action: "soft_delete", record: incoming };
  }

  if (incomingDeleted && localDeleted) {
    if (incoming.updated_at >= local.updated_at) {
      return { action: "update_deleted_record", record: incoming };
    }
    return { action: "ignore", record: local };
  }

  if (!incomingDeleted && localDeleted) {
    return { action: "ignore", record: local };
  }

  if (incoming.updated_at > local.updated_at) {
    return { action: "update", record: incoming };
  }

  if (incoming.updated_at === local.updated_at) {
    return { action: "ignore_keep_server", record: local };
  }

  return { action: "ignore", record: local };
}
```

## 12.2 服务端必须做的事
- 校验 `deviceId`
- 校验时间字段格式
- 校验 `sync_id`
- 统一记录 `server_updated_at`
- 统一写同步日志
- 统计 applied / ignored / conflicts
- 返回标准化 `changes`

## 12.3 服务端不建议做的事
- 客户端和服务端各自写不同冲突规则
- 根据业务字段猜测性自动 merge
- 物理删除同步对象
- 不记录同步日志

---

## 13. 客户端实现建议

## 13.1 客户端同步流程
1. 收集本地自上次同步以来的增量
2. 发起 bidirectional sync
3. 解析服务端返回
4. 应用 `changes`
5. 本地执行 upsert 或 soft delete
6. 更新同步游标
7. 记录最近一次同步结果

## 13.2 客户端必须保证
- `sync_id` 稳定不变
- 时间统一为 UTC
- 重复应用同一条变更不会破坏状态
- 收到 `deleted_at` 时执行软删除
- 不应把已删除对象直接彻底清掉
- 同步失败后不能提前更新 `lastSyncAt`

## 13.3 客户端推荐保留的状态
```json
{
  "lastSyncAt": "2026-04-21T09:10:03.125Z",
  "lastSyncStatus": "success",
  "lastSyncError": null,
  "lastSyncDeviceId": "device_android_001"
}
```

---

## 14. v2 演进建议：引入 changeId

当前阶段可以先继续使用 `lastSyncAt`，但建议后续升级为：

## 14.1 变更表
服务端维护变更流水：

| 字段 | 说明 |
|------|------|
| `change_id` | 自增主键 |
| `entity_type` | logs / dictionaries / history / callsignQthHistory |
| `sync_id` | 记录唯一标识 |
| `action` | insert / update / delete |
| `server_updated_at` | 服务端接收时间 |
| `user_id` | 所属用户 |
| `device_id` | 来源设备 |

## 14.2 客户端游标
客户端保存：

```json
{
  "lastSyncAt": "2026-04-21T09:10:03.125Z",
  "lastChangeId": 1287
}
```

## 14.3 v2 优点
- 避免同一时间戳边界问题
- 方便分页同步
- 方便审计与调试
- 更适合未来扩展多设备场景

---

## 15. 日志与可观测性

同步系统最怕黑盒，因此建议服务端记录以下日志字段：

```json
{
  "userId": 1001,
  "deviceId": "device_android_001",
  "direction": "bidirectional",
  "received": {
    "logs": 12,
    "dictionaries": 2,
    "history": 4,
    "callsignQthHistory": 1
  },
  "applied": {
    "logs": 11,
    "dictionaries": 2,
    "history": 4,
    "callsignQthHistory": 1
  },
  "ignored": {
    "logs": 1,
    "dictionaries": 0,
    "history": 0,
    "callsignQthHistory": 0
  },
  "conflicts": 1,
  "startedAt": "2026-04-21T09:10:00.100Z",
  "finishedAt": "2026-04-21T09:10:03.125Z",
  "status": "success"
}
```

建议最少能查到：
- 哪个用户
- 哪个设备
- 哪个时间
- 上传了多少
- 应用了多少
- 忽略了多少
- 是否有冲突
- 是否失败

---

## 16. 测试用例建议

以下用例建议尽早加入。

## 16.1 首次同步
- 本地为空，服务端有完整数据
- 首次同步后客户端成功写入
- 同步游标成功更新

## 16.2 普通增量同步
- 本地新增 1 条 log
- 服务端新增 1 条 log
- 双向同步后两边都能看到 2 条新数据

## 16.3 修改 vs 修改
- A 设备修改 note
- B 设备也修改 note
- 以 `updated_at` 新者为准

## 16.4 删除 vs 修改
- A 设备删除一条记录
- B 设备修改同一条记录
- 同步后保留删除状态

## 16.5 重复同步幂等
- 同一批 payload 重复提交 2 次
- 最终状态不应重复插入或错乱

## 16.6 时间边界
- 多条记录具有同一毫秒时间戳
- 不应漏拉、漏写、漏删

## 16.7 错误恢复
- 同步中途网络失败
- 客户端不得错误更新 `lastSyncAt`
- 重试后系统应可恢复一致

---

## 17. 客户端与服务端对齐任务清单

## 17.1 客户端
- [ ] 检查所有同步表是否都具备 `sync_id`
- [ ] 检查所有同步表是否都具备 `created_at / updated_at / deleted_at`
- [ ] 检查 `source_device_id` 是否统一
- [ ] 确保所有时间都转为 UTC ISO8601
- [ ] 确保收到 `deleted_at` 时一定执行软删除
- [ ] 确保重复应用 changes 时幂等
- [ ] 确保同步失败时不更新游标
- [ ] 保留最近一次同步状态与错误信息

## 17.2 服务端
- [ ] 明确并统一记录级冲突规则
- [ ] 明确并硬编码删除优先
- [ ] 所有同步对象统一返回标准 `changes`
- [ ] 统一统计 applied / ignored / conflicts
- [ ] 记录 `server_updated_at`
- [ ] 记录同步日志
- [ ] 统一错误响应格式
- [ ] 为 changeId / revision 预留升级空间

## 17.3 协议
- [ ] 固定 bidirectional 请求体结构
- [ ] 固定 bidirectional 响应体结构
- [ ] 固定 pull 响应体结构
- [ ] 固定 push 响应体结构
- [ ] 固定 nextSyncToken 格式
- [ ] 固定时间格式
- [ ] 固定冲突规则说明

---

## 18. 推荐推进顺序

## 第一阶段：先把规则定死
重点：
- 删除优先级
- 修改冲突规则
- 响应结构统一
- 客户端幂等保证

## 第二阶段：增强调试能力
重点：
- 同步日志
- 错误码
- summary 统计
- 失败恢复

## 第三阶段：升级游标模型
重点：
- changeId
- revision
- 变更流水
- 分页同步

---

## 19. 最终结论

当前 OpenLogTool 的同步系统已经不是概念设计，而是：

> 客户端本地数据库 + 服务端同步中枢 的第一版可运行实现。

接下来最重要的不是继续“加功能”，而是：

> 把同步规则、冲突逻辑、响应结构、错误处理和游标机制从隐式实现收紧成显式协议。

只要这一步做好，后续无论是继续补 Web 管理、分享功能、设备管理还是 changeId 升级，都会稳很多。

---

## 20. 附录：推荐最小协议模板

## 20.1 最小同步对象模板
```json
{
  "sync_id": "uuid",
  "created_at": "2026-04-21T09:00:00.000Z",
  "updated_at": "2026-04-21T09:05:00.000Z",
  "deleted_at": null,
  "source_device_id": "device_android_001"
}
```

## 20.2 最小双向同步响应模板
```json
{
  "ok": true,
  "serverTime": "2026-04-21T09:10:03.125Z",
  "summary": {
    "received": {},
    "applied": {},
    "ignored": {},
    "conflicts": 0
  },
  "changes": {
    "logs": [],
    "dictionaries": {
      "bands": [],
      "modes": [],
      "rigs": [],
      "antennas": []
    },
    "history": [],
    "callsignQthHistory": []
  },
  "nextSyncToken": {
    "lastSyncAt": "2026-04-21T09:10:03.125Z"
  }
}
```
