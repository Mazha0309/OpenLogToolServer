# OpenLogTool Live Share 与协作记录设计文档（真实字段版 v1）

## 1. 文档目的

本文档用于规范 OpenLogTool 的两个在线能力：

1. **Live Share 公开只读展示**
   - 无需登录可查看
   - 不可修改
   - 展示当前 session 的记录表格
   - 展示当前时间
   - 展示当前主控呼号
   - 客户端可获取并打开链接

2. **协作记录**
   - 多个客户端共同记录同一个 session
   - 服务端作为在线协作权威状态
   - WebSocket 广播变更
   - 本地 SQLite 作为缓存与离线补偿
   - 现有 bidirectional sync 作为兜底

示例统一按照当前日志字段编写：

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

---

## 2. 总体关系

```text
session = 一整次总记录 / 一个协作房间
logs = session 下的日志明细
live share = session 的公开只读页面
collaboration = 登录或授权客户端共同编辑 session
```

三者关系：

```text
客户端 A / B / C 协作编辑 session
        ↓
服务端保存 sessions + logs
        ↓
服务端广播变更给协作者
        ↓
Live Share 页面只读展示同一个 session
```

---

## 3. Live Share 公开只读展示

### 3.1 页面目标

Live Share 页面用于对外展示正在记录的 session。

要求：

- 无需登录可查看
- 不可修改
- 显示 `session.title`
- 显示当前时间
- 显示当前主控呼号
- 显示 logs 表格
- 可被客户端拉起
- 客户端可直接获取链接

---

### 3.2 页面路径

不建议直接暴露 `session_id`。

推荐使用 `share_code`：

```text
/live/:shareCode
```

示例：

```text
https://server.example.com/live/AbC9xK2mPq7R
```

内部映射：

```text
share_code -> session_id
```

---

### 3.3 公开链接表

```sql
CREATE TABLE session_public_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  share_code TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  view_options_json TEXT
);
```

---

### 3.4 创建或获取公开链接

```http
POST /api/v1/sessions/:sessionId/public-link
Authorization: Bearer <token>
```

请求：

```json
{
  "enabled": true,
  "expiresAt": null,
  "viewOptions": {
    "showCurrentTime": true,
    "showController": true,
    "showNotes": true
  }
}
```

响应：

```json
{
  "ok": true,
  "url": "https://server.example.com/live/AbC9xK2mPq7R",
  "shareCode": "AbC9xK2mPq7R",
  "sessionId": "9f8c2a7d4e12bb9010d3c4a88f91e2b7"
}
```

客户端拿到后可以：

- 复制链接
- 浏览器打开
- 分享
- 投屏
- 生成二维码

---

## 4. 公开数据接口

```http
GET /api/public/live/:shareCode
```

响应示例：

```json
{
  "ok": true,
  "serverTime": "2026-04-30T13:20:00.000Z",
  "session": {
    "session_id": "9f8c2a7d4e12bb9010d3c4a88f91e2b7",
    "title": "2026-04-30 晚间点名",
    "status": "active",
    "created_at": "2026-04-30T12:30:00.000Z",
    "updated_at": "2026-04-30T13:19:58.000Z",
    "closed_at": null
  },
  "controller": {
    "callsign": "BG5CRL",
    "source": "latest_log"
  },
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
  "meta": {
    "total": 1,
    "lastUpdatedAt": "2026-04-30T13:19:58.000Z",
    "readonly": true
  }
}
```

公开接口不要返回：

- `user_id`
- token
- 登录态
- 内部自增数据库 id
- 私有配置
- 不应展示的软删除记录

第一版建议不展示：

```text
deleted_at != null 的 logs
```

---

## 5. Live Share 标题

Live Share 页面顶部标题使用：

```text
session.title
```

例如：

```text
2026-04-30 晚间点名
```

创建 session 时用户输入的 session name 保存到：

```text
sessions.title
```

---

## 6. 当前主控呼号

不单独维护主控上报机制。

当前主控直接来自当前 session 下最新一条有效日志的 `controller` 字段。

查询规则：

```sql
SELECT controller
FROM logs
WHERE session_id = ?
  AND deleted_at IS NULL
  AND controller IS NOT NULL
  AND controller != ''
ORDER BY updated_at DESC
LIMIT 1;
```

返回：

```json
{
  "controller": {
    "callsign": "BG5CRL",
    "source": "latest_log"
  }
}
```

如果没有日志或没有 controller：

```json
{
  "controller": {
    "callsign": null,
    "source": "none"
  }
}
```

页面显示：

```text
当前主控：BG5CRL
```

或：

```text
当前主控：暂无
```

---

## 7. Live Share 刷新策略

第一版建议使用轮询：

```text
每 3 秒 GET /api/public/live/:shareCode
```

后续可升级为 SSE 或 WebSocket。

---

## 8. 协作记录模型

推荐采用：

```text
服务端权威协作 + 客户端本地缓存 + WebSocket 实时通知 + bidirectional sync 兜底
```

含义：

```text
在线时：
客户端提交变更 -> 服务端保存 -> 服务端广播 -> 其他客户端更新本地 SQLite

离线时：
客户端本地保存 -> 恢复在线后通过 bidirectional sync 补交
```

不要让多个客户端只靠本地合并碰运气。

---

## 9. session 作为协作房间

```text
一个 session = 一个协作房间
```

示例：

```text
session_id = 9f8c2a7d4e12bb9010d3c4a88f91e2b7
title = 2026-04-30 晚间点名
```

所有协作者都编辑这个 session 下的 logs。

---

## 10. 协作 API

### 10.1 新增或修改日志

```http
POST /api/v1/sessions/:sessionId/logs/upsert
Authorization: Bearer <token>
```

请求：

```json
{
  "deviceId": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
  "log": {
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
    "updated_at": "2026-04-30T12:32:00.000Z",
    "deleted_at": null,
    "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42"
  }
}
```

响应：

```json
{
  "ok": true,
  "change_id": 1025,
  "log": {
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
    "updated_at": "2026-04-30T12:32:00.000Z",
    "deleted_at": null,
    "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
    "version": 2
  }
}
```

---

### 10.2 删除日志

```http
DELETE /api/v1/sessions/:sessionId/logs/:syncId
Authorization: Bearer <token>
```

请求：

```json
{
  "deviceId": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
  "deleted_at": "2026-04-30T12:45:00.000Z"
}
```

响应：

```json
{
  "ok": true,
  "change_id": 1026,
  "log": {
    "sync_id": "log-1770000000000000-a1b2c3d4e5f60708",
    "session_id": "9f8c2a7d4e12bb9010d3c4a88f91e2b7",
    "deleted_at": "2026-04-30T12:45:00.000Z",
    "updated_at": "2026-04-30T12:45:00.000Z",
    "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42"
  }
}
```

---

### 10.3 补拉变更

```http
GET /api/v1/sessions/:sessionId/changes?since=1024
Authorization: Bearer <token>
```

响应：

```json
{
  "ok": true,
  "changes": [
    {
      "change_id": 1025,
      "type": "log.upserted",
      "session_id": "9f8c2a7d4e12bb9010d3c4a88f91e2b7",
      "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
      "payload": {
        "log": {
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
          "updated_at": "2026-04-30T12:32:00.000Z",
          "deleted_at": null,
          "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
          "version": 2
        }
      }
    }
  ],
  "next_change_id": 1025
}
```

---

## 11. WebSocket 设计

### 11.1 客户端连接

```text
/ws?sessionId=9f8c2a7d4e12bb9010d3c4a88f91e2b7&deviceId=c6f3e9a7b8d94a2fa11c3e5d61f90a42
```

服务端把连接加入房间：

```text
session:{session_id}
```

---

### 11.2 log.upserted 广播

```json
{
  "type": "log.upserted",
  "session_id": "9f8c2a7d4e12bb9010d3c4a88f91e2b7",
  "change_id": 1025,
  "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
  "log": {
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
    "updated_at": "2026-04-30T12:32:00.000Z",
    "deleted_at": null,
    "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
    "version": 2
  }
}
```

客户端处理：

```text
if source_device_id == 本机 deviceId:
    可忽略，或用服务端返回版本校准
else:
    upsert 到本地 SQLite
```

---

### 11.3 log.deleted 广播

```json
{
  "type": "log.deleted",
  "session_id": "9f8c2a7d4e12bb9010d3c4a88f91e2b7",
  "change_id": 1026,
  "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
  "sync_id": "log-1770000000000000-a1b2c3d4e5f60708",
  "deleted_at": "2026-04-30T12:45:00.000Z",
  "updated_at": "2026-04-30T12:45:00.000Z"
}
```

客户端处理：

```text
本地按 sync_id 执行软删除
```

---

## 12. change_log 设计

为了断线补偿和同步游标，建议增加 `change_log`。

```sql
CREATE TABLE change_log (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_device_id TEXT,
  server_created_at TEXT NOT NULL
);
```

示例：

```json
{
  "change_id": 1025,
  "session_id": "9f8c2a7d4e12bb9010d3c4a88f91e2b7",
  "entity_type": "log",
  "entity_sync_id": "log-1770000000000000-a1b2c3d4e5f60708",
  "action": "upsert",
  "source_device_id": "c6f3e9a7b8d94a2fa11c3e5d61f90a42",
  "server_created_at": "2026-04-30T12:32:01.000Z"
}
```

客户端保存：

```text
last_change_id
```

断线恢复后：

```http
GET /api/v1/sessions/:sessionId/changes?since={last_change_id}
```

---

## 13. 冲突处理

第一版建议简单规则。

### 13.1 在线协作

```text
最后被服务端接受的修改胜出
```

这比完全依赖客户端 `updated_at` 更稳。

### 13.2 删除优先

如果一条 log 已被删除：

```text
旧修改不能复活它
```

### 13.3 session_id 不允许变

同一条 log 的 `session_id` 不应被修改。

如果服务端收到：

```text
同 sync_id 但 session_id 不同
```

建议拒绝或记录冲突。

---

## 14. 权限边界

必须区分：

```text
Live Share = 无需登录，只读
Collaboration = 可编辑，必须有权限
```

公开页面链接：

```text
/live/:shareCode
```

只能 GET，只读。

协作编辑应使用：

```text
登录态 / session invite token / collaborator role
```

后续可设计角色：

```text
owner
editor
viewer
```

---

## 15. 与 bidirectional sync 的关系

协作 API 和 WebSocket 是在线实时路径。

现有 `/sync/bidirectional` 是离线补偿路径。

推荐关系：

```text
在线编辑：
  logs/upsert -> change_log -> WebSocket broadcast

离线恢复：
  bidirectional sync -> 服务端合并 -> change_log -> WebSocket broadcast
```

---

## 16. 推荐开发阶段

### 第一阶段：Live Share 最小闭环

- [ ] 增加 `session_public_links`
- [ ] 创建/获取 public link API
- [ ] 增加公开数据 API
- [ ] 增加 `/live/:shareCode`
- [ ] 显示 `session.title`
- [ ] 显示当前时间
- [ ] 从最新 log.controller 推导当前主控
- [ ] 显示 logs 表格
- [ ] 客户端可以打开/复制链接

### 第二阶段：伪实时协作

- [ ] 多客户端都能同步同一个 session
- [ ] 每次修改后立即 push / bidirectional sync
- [ ] 其他客户端轮询或收到通知后刷新

### 第三阶段：真正实时协作

- [ ] 增加 WebSocket
- [ ] 增加 change_log
- [ ] 增加 logs/upsert API
- [ ] 增加 logs/delete API
- [ ] 增加 changes?since API
- [ ] 客户端收到 WebSocket 后更新本地 SQLite

### 第四阶段：协作者管理

- [ ] session_collaborators 表
- [ ] 邀请链接
- [ ] owner/editor/viewer 权限
- [ ] 在线状态 presence

---

## 17. 最终建议

推荐最终架构：

```text
session = 协作房间
logs = session 下的记录明细
sync_id = 单条 log 的稳定同步 ID
session_id = 一整次总记录 ID
service = 在线协作权威状态
SQLite = 本地缓存 + 离线补偿
WebSocket = 实时通知
bidirectional sync = 兜底同步
live share = 公开只读展示
```

最小可落地闭环：

```text
1. sessions + logs 数据模型统一
2. Live Share 只读页面先跑通
3. 多客户端同步同一 session
4. 再上 WebSocket + change_log
```
