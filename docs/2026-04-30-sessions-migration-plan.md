# Sessions Migration 实施计划

> **对执行代理：** 使用 superpowers:subagent-driven-development 按任务逐步执行。步骤使用 `- [ ]` checkbox 跟踪。

**目标：** 将 `logs + history(JSON快照)` 重构为 `sessions + logs(session_id关联)`

**架构：** 新增 sessions 表作为总记录载体，logs 通过 session_id 关联。服务端先处理后端重构，客户端后处理前端重构和迁移。

**技术栈：** Server: Node.js/Express + Memory/MySQL/MongoDB 适配器 | Client: Flutter/Dart + SQLite(sqflite)

**分支：** Server 在 `dev` | Client 在 `test`

---

## 文件结构总览

### 服务端 (OpenLogToolServer)
```
src/
├── models/
│   └── session.js          [NEW] Session 模型
├── database/
│   ├── repository.js       [MODIFY] 增加 SessionRepository
│   └── adapters/
│       ├── memory.js       [MODIFY] 增加 sessions CRUD + sync 方法
│       ├── mysql.js        [MODIFY] 增加 sessions 表 + CRUD + sync
│       └── mongodb.js      [MODIFY] 增加 sessions 集合 + CRUD + sync
├── services/
│   └── index.js            [MODIFY] SyncService 增加 sessions 处理，调整处理顺序
├── api/
│   └── routes/
│       └── logs.js         [MODIFY] 同步端点支持 sessions
├── utils/
│   └── sync-helpers.js     [MODIFY] 增加 sessions 字段转换
└── migrations/
    └── history-to-sessions.js [NEW] 一次性迁移脚本
```

### 客户端 (openlogtool)
```
lib/
├── models/
│   └── session.dart             [NEW] Session 模型
├── database/
│   └── database_helper.dart     [MODIFY] 增加 sessions 表、logs.session_id 列
├── providers/
│   ├── session_provider.dart    [NEW] Session 生命周期管理
│   ├── sync_provider.dart       [MODIFY] 同步 payload 增加 sessions
│   └── log_provider.dart        [MODIFY] clearAllLogs → startNewSession
└── services/
    └── instance_service.dart    [NEW] client_instance_id 管理
```

---

## Phase 1: 服务端

### Task 1: Session 模型

**Files:**
- Create: `src/models/session.js`

- [ ] **Step 1: 创建 Session 模型**

```js
// src/models/session.js
import { createHash } from 'crypto';

export const SESSION_STATUS = {
  ACTIVE: 'active',
  CLOSED: 'closed',
  ARCHIVED: 'archived',
};

export class Session {
  constructor(data = {}) {
    this.session_id = data.session_id;
    this.title = data.title;
    this.status = data.status || SESSION_STATUS.ACTIVE;
    this.created_at = data.created_at ? new Date(data.created_at) : new Date();
    this.updated_at = data.updated_at ? new Date(data.updated_at) : new Date(this.created_at);
    this.closed_at = data.closed_at ? new Date(data.closed_at) : null;
    this.deleted_at = data.deleted_at ? new Date(data.deleted_at) : null;
    this.source_device_id = data.source_device_id || null;

    this._validate();
  }

  _validate() {
    if (!this.session_id || typeof this.session_id !== 'string') {
      throw new Error('Session.session_id is required');
    }
    if (!this.title || typeof this.title !== 'string') {
      throw new Error('Session.title is required');
    }
    if (!Object.values(SESSION_STATUS).includes(this.status)) {
      throw new Error('Session.status must be active/closed/archived');
    }
  }

  toJSON() {
    return {
      session_id: this.session_id,
      title: this.title,
      status: this.status,
      created_at: this.created_at instanceof Date ? this.created_at.toISOString() : this.created_at,
      updated_at: this.updated_at instanceof Date ? this.updated_at.toISOString() : this.updated_at,
      closed_at: this.closed_at instanceof Date ? this.closed_at.toISOString() : this.closed_at,
      deleted_at: this.deleted_at instanceof Date ? this.deleted_at.toISOString() : this.deleted_at,
      source_device_id: this.source_device_id,
    };
  }

  static fromJSON(obj) {
    if (!obj) return null;
    return new Session(obj);
  }

  static fromMap(map) {
    if (!map) return null;
    return new Session(map);
  }

  static generateSessionId(clientInstanceId = 'server') {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2, 10);
    const raw = `${clientInstanceId}:${timestamp}:${random}`;
    return createHash('sha256').update(raw).digest('hex').substring(0, 32);
  }

  static migrationSessionId(historySyncId) {
    const raw = `history-migration:${historySyncId}`;
    return createHash('sha256').update(raw).digest('hex').substring(0, 32);
  }
}

export default Session;
```

- [ ] **Step 2: 更新 models/index.js**

```js
// 在现有 export 中增加
import Session, { SESSION_STATUS } from './session.js';
// export { ..., Session, SESSION_STATUS };
```

### Task 2: SessionRepository

**Files:**
- Modify: `src/database/repository.js`

- [ ] **Step 1: 在 repository.js 末尾增加 SessionRepository**

```js
// src/database/repository.js 末尾增加

export class SessionRepository {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async findBySessionId(sessionId) {
    return this.adapter.findSessionById(sessionId);
  }

  async findSince(timestamp, userId) {
    return this.adapter.findSessionsSince(timestamp, userId);
  }

  async upsert(data, userId) {
    return this.adapter.upsertSessionSync(data, userId);
  }

  async softDelete(sessionId, deletedAt, userId) {
    return this.adapter.softDeleteSession(sessionId, deletedAt, userId);
  }

  async findByStatus(status, userId) {
    return this.adapter.findSessionsByStatus(status, userId);
  }

  async findAll(userId) {
    return this.adapter.findSessions(userId);
  }
}
```

### Task 3: Memory Adapter 增加 sessions 方法

**Files:**
- Modify: `src/database/adapters/memory.js`

- [ ] **Step 1: 在 constructor 中初始化 sessions 存储**

在 `this.histories = [];` 之后增加：
```js
this.sessions = [];
```

- [ ] **Step 2: 增加 sessions CRUD 方法**

在 history 方法组末尾增加：

```js
  // Sessions
  async findSessionById(sessionId) {
    const session = this.sessions.find(s => s.session_id === sessionId && !s.deleted_at);
    return session || null;
  }

  async findSessionsSince(timestamp, userId) {
    const since = new Date(timestamp);
    const userSessions = userId ? this.sessions.filter(s => s.user_id === userId) : this.sessions;
    return userSessions.filter(s => {
      const updated = new Date(s.updated_at || s.created_at);
      const deleted = s.deleted_at ? new Date(s.deleted_at) : null;
      return updated > since || (deleted && deleted > since);
    });
  }

  async findSessionsByStatus(status, userId) {
    return this.sessions.filter(s =>
      s.status === status && !s.deleted_at &&
      (!userId || s.user_id === userId)
    );
  }

  async findSessions(userId) {
    return this.sessions.filter(s =>
      !s.deleted_at && (!userId || s.user_id === userId)
    );
  }

  async createSession(data, userId) {
    const session = { ...data, user_id: userId };
    this.sessions.push(session);
    return session;
  }

  async upsertSessionSync(data, userId) {
    const existing = this.sessions.find(s => s.session_id === data.session_id);
    if (existing) {
      const existingTime = new Date(existing.updated_at || existing.created_at).getTime();
      const incomingTime = new Date(data.updated_at || data.created_at).getTime();
      if (incomingTime > existingTime) {
        Object.assign(existing, data, { user_id: userId });
      }
      return existing;
    }
    const session = { ...data, user_id: userId };
    this.sessions.push(session);
    return session;
  }

  async softDeleteSession(sessionId, deletedAt, userId) {
    const session = this.sessions.find(s => s.session_id === sessionId);
    if (session) {
      session.deleted_at = deletedAt;
      session.updated_at = deletedAt;
    }
  }
```

### Task 4: MySQL Adapter 增加 sessions 表和方法

**Files:**
- Modify: `src/database/adapters/mysql.js`

- [ ] **Step 1: 在 ensureTables 中增加 sessions 表**

在 ensureTables 方法中增加：
```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  status ENUM('active','closed','archived') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  closed_at DATETIME(3) NULL,
  deleted_at DATETIME(3) NULL,
  source_device_id VARCHAR(255) NULL,
  user_id VARCHAR(64) NULL,
  INDEX idx_sessions_status (status),
  INDEX idx_sessions_updated (updated_at),
  INDEX idx_sessions_user (user_id)
);
```

并在 logs 表迁移中增加：
```sql
ALTER TABLE logs ADD COLUMN IF NOT EXISTS session_id VARCHAR(64) NULL;
CREATE INDEX IF NOT EXISTS idx_logs_session_id ON logs(session_id);
```

- [ ] **Step 2: 增加 sessions CRUD 方法**

增加 findSessionById, findSessionsSince, findSessionsByStatus, findSessions, createSession, upsertSessionSync, softDeleteSession 方法。参照 memory adapter 模式，使用 MySQL 参数化查询。

### Task 5: MongoDB Adapter 增加 sessions

**Files:**
- Modify: `src/database/adapters/mongodb.js`

- [ ] **Step 1: 增加 sessions 集合 schema**

```js
const sessionSchema = new mongoose.Schema({
  session_id: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  status: { type: String, enum: ['active','closed','archived'], default: 'active' },
  created_at: { type: Date, required: true },
  updated_at: { type: Date, required: true },
  closed_at: Date,
  deleted_at: Date,
  source_device_id: String,
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});
```

- [ ] **Step 2: 增加 sessions CRUD 方法**

参照 memory adapter 模式，使用 Mongoose API。

### Task 6: SyncService 增加 sessions 处理

**Files:**
- Modify: `src/services/index.js`

- [ ] **Step 1: SyncService.init() 初始化 SessionRepository**

在 init() 中增加：
```js
this.sessionRepo = new SessionRepository(adapter);
```

- [ ] **Step 2: _normalizePayload 增加 sessions**

在 _normalizePayload 返回中增加：
```js
sessions: Array.isArray(payload.sessions) ? payload.sessions.map(fromSyncProtocolFields) : [],
```

- [ ] **Step 3: 调整 bidirectionalSync 处理顺序**

重构 bidirectionalSync，将 sessions 处理移到 logs 之前：

```js
// 1. 先拉取服务端数据
const [serverSessions, serverLogs, ...] = await Promise.all([
  this.sessionRepo.findSince(lastSyncAt, userId),
  ...
]);

// 2. 先处理 sessions
const sessionStats = await this._mergeCollection(
  normalized.sessions,
  item => this.sessionRepo.findBySessionId(item.session_id ?? item.sessionId),
  item => this.sessionRepo.upsert(item, userId),
);

// 3. 再处理 logs
const logStats = await this._mergeCollection(...);
```

- [ ] **Step 4: changes 返回 sessions**

在返回的 changes 中增加：
```js
sessions: serverSessions.map(toSyncProtocolFields),
```

- [ ] **Step 5: pushSync 同样支持 sessions**

在 pushSync 中增加 sessions 处理（同样先于 logs）。

### Task 7: sync-helpers 增加 sessions 字段转换

**Files:**
- Modify: `src/utils/sync-helpers.js`

- [ ] **Step 1: 在 toSyncProtocolFields 中增加 sessions 字段**

```js
if ('sessionId' in out) { out.session_id = out.sessionId; delete out.sessionId; }
if ('closedAt' in out) { out.closed_at = out.closedAt; delete out.closedAt; }
```

- [ ] **Step 2: 在 fromSyncProtocolFields 中增加 sessions 字段**

```js
if ('session_id' in out) { out.sessionId = out.session_id; delete out.session_id; }
if ('closed_at' in out) { out.closedAt = out.closed_at; delete out.closed_at; }
```

### Task 8: API 路由更新

**Files:**
- Modify: `src/api/routes/logs.js`

- [ ] **Step 1: 同步端点验证增加 sessions**

无需额外修改——payload 验证已通过 SyncService._normalizePayload 处理。

- [ ] **Step 2: 增加 sessions 查询 API**

```js
// GET /api/v1/sessions - 如果需新路由
router.get('/sessions', authMiddleware, async (req, res) => {
  const sessions = await syncService.sessionRepo.findAll(req.user.id);
  res.json({ ok: true, data: sessions });
});
```

### Task 9: 历史迁移脚本

**Files:**
- Create: `migrations/history-to-sessions.js`

- [ ] **Step 1: 创建迁移脚本**

```js
// migrations/history-to-sessions.js
import { createHash } from 'crypto';
import connector from '../src/database/connector.js';
import { HistoryRepository, SessionRepository } from '../src/database/repository.js';

function migrationSessionId(historySyncId) {
  const raw = `history-migration:${historySyncId}`;
  return createHash('sha256').update(raw).digest('hex').substring(0, 32);
}

async function migrate() {
  const adapter = await connector.connect();
  const historyRepo = new HistoryRepository(adapter);
  const sessionRepo = new SessionRepository(adapter);

  const histories = await historyRepo.findAll();

  for (const h of histories) {
    const sessionId = migrationSessionId(h.sync_id || h.syncId);
    const existing = await sessionRepo.findBySessionId(sessionId);
    if (existing) continue;

    await sessionRepo.upsert({
      session_id: sessionId,
      title: h.name || '未命名记录',
      status: 'closed',
      created_at: h.created_at || h.createdAt,
      updated_at: h.updated_at || h.updatedAt,
      closed_at: h.created_at || h.createdAt,
      source_device_id: h.source_device_id || h.sourceDeviceId,
    }, h.user_id || h.userId);

    console.log(`Migrated history ${h.sync_id || h.syncId} → session ${sessionId}`);
  }

  console.log(`Migration complete: ${histories.length} histories → sessions`);
  await connector.disconnect();
}

migrate().catch(console.error);
```

---

## Phase 2: 客户端

### Task 10: client_instance_id 服务

**Files:**
- Create: `lib/services/instance_service.dart`

- [ ] **Step 1: 创建 InstanceService**

```dart
// lib/services/instance_service.dart
import 'dart:math';
import 'package:shared_preferences/shared_preferences.dart';

class InstanceService {
  static const _key = 'client_instance_id';
  static String? _cached;

  static Future<String> getInstanceId() async {
    if (_cached != null) return _cached!;

    final prefs = await SharedPreferences.getInstance();
    _cached = prefs.getString(_key);

    if (_cached == null || _cached!.isEmpty) {
      _cached = _generateId();
      await prefs.setString(_key, _cached!);
    }

    return _cached!;
  }

  static String _generateId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return bytes
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
  }

  static Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
    _cached = null;
  }
}
```

### Task 11: Session 模型

**Files:**
- Create: `lib/models/session.dart`

- [ ] **Step 1: 创建 Session 模型**

```dart
// lib/models/session.dart
import 'dart:math';
import 'package:openlogtool/services/instance_service.dart';
import 'package:crypto/crypto.dart';
import 'dart:convert';

class Session {
  final String sessionId;
  final String title;
  final String status; // active, closed, archived
  final String createdAt;
  final String updatedAt;
  final String? closedAt;
  final String? deletedAt;
  final String? sourceDeviceId;

  const Session({
    required this.sessionId,
    required this.title,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.closedAt,
    this.deletedAt,
    this.sourceDeviceId,
  });

  static Future<String> generateSessionId() async {
    final instanceId = await InstanceService.getInstanceId();
    final timestamp = DateTime.now().toUtc().microsecondsSinceEpoch.toString();
    final random = Random.secure().nextInt(1 << 32).toRadixString(16);
    final raw = '$instanceId:$timestamp:$random';
    final bytes = utf8.encode(raw);
    final digest = sha256.convert(bytes);
    return digest.toString().substring(0, 32);
  }

  static String migrationSessionId(String historySyncId) {
    final raw = 'history-migration:$historySyncId';
    final bytes = utf8.encode(raw);
    final digest = sha256.convert(bytes);
    return digest.toString().substring(0, 32);
  }

  factory Session.fromMap(Map<String, dynamic> map) {
    return Session(
      sessionId: map['session_id']?.toString() ?? '',
      title: map['title']?.toString() ?? '',
      status: map['status']?.toString() ?? 'active',
      createdAt: map['created_at']?.toString() ?? DateTime.now().toUtc().toIso8601String(),
      updatedAt: map['updated_at']?.toString() ?? DateTime.now().toUtc().toIso8601String(),
      closedAt: _nullable(map['closed_at']),
      deletedAt: _nullable(map['deleted_at']),
      sourceDeviceId: _nullable(map['source_device_id']),
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'session_id': sessionId,
      'title': title,
      'status': status,
      'created_at': createdAt,
      'updated_at': updatedAt,
      'closed_at': closedAt,
      'deleted_at': deletedAt,
      'source_device_id': sourceDeviceId,
    };
  }

  static String? _nullable(dynamic value) {
    if (value == null) return null;
    final s = value.toString().trim();
    return s.isEmpty ? null : s;
  }

  Session copyWith({
    String? sessionId,
    String? title,
    String? status,
    String? createdAt,
    String? updatedAt,
    Object? closedAt = _sentinel,
    Object? deletedAt = _sentinel,
    Object? sourceDeviceId = _sentinel,
  }) {
    return Session(
      sessionId: sessionId ?? this.sessionId,
      title: title ?? this.title,
      status: status ?? this.status,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      closedAt: identical(closedAt, _sentinel) ? this.closedAt : closedAt as String?,
      deletedAt: identical(deletedAt, _sentinel) ? this.deletedAt : deletedAt as String?,
      sourceDeviceId: identical(sourceDeviceId, _sentinel) ? this.sourceDeviceId : sourceDeviceId as String?,
    );
  }
}

const _sentinel = Object();
```

**注意**: Flutter 需要添加 `crypto` 依赖到 `pubspec.yaml`：
```yaml
dependencies:
  crypto: ^3.0.3
```

### Task 12: 数据库迁移（sessions 表 + logs.session_id）

**Files:**
- Modify: `lib/database/database_helper.dart`

- [ ] **Step 1: 增加 sessions 表常量**

在类顶部增加：
```dart
static const String _sessionsTable = 'sessions';
```

- [ ] **Step 2: 创建 sessions 表**

```dart
Future<void> _createSessionsTable(Database db, {bool ifNotExists = false}) async {
  await db.execute('''
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}$_sessionsTable (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      deleted_at TEXT,
      source_device_id TEXT
    )
  ''');
  if (!ifNotExists) {
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_sessions_status ON $_sessionsTable(status)',
    );
  }
}
```

- [ ] **Step 3: 在 _onOpen 和 _onCreate 中调用**

```dart
await _ensureSessionsTableExists(db);
```

- [ ] **Step 4: 增加 _ensureSessionsTableExists**

```dart
Future<void> _ensureSessionsTableExists(Database db) async {
  await _createSessionsTable(db, ifNotExists: true);
}
```

- [ ] **Step 5: logs 表增加 session_id**

```dart
Future<void> _migrateLogsTable(Database db) async {
  // 现有迁移代码 ...
  await _ensureColumn(db, _logsTable, 'session_id', 'TEXT');
  // 现有索引创建代码之后增加:
  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_logs_session_id ON $_logsTable(session_id)',
  );
}
```

- [ ] **Step 6: _buildLogRow 增加 session_id**

在 `_buildLogRow` 返回的 map 中增加：
```dart
'session_id': log.sessionId,
```

- [ ] **Step 7: LogEntry 增加 sessionId 字段**

修改 `lib/models/log_entry.dart`：
```dart
// 增加字段
final String? sessionId;

// 在 factory 和 fromJson/fromMap 中增加
sessionId: _normalizeNullableString(json['session_id'] ?? json['sessionId']),

// 在 toMap 中增加
'session_id': sessionId,
```

### Task 13: SessionProvider + Session 生命周期管理

**Files:**
- Create: `lib/providers/session_provider.dart`

- [ ] **Step 1: 创建 SessionProvider**

```dart
// lib/providers/session_provider.dart
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:openlogtool/database/database_helper.dart';
import 'package:openlogtool/models/session.dart';
import 'package:openlogtool/services/instance_service.dart';

class SessionProvider with ChangeNotifier {
  static const _key = 'current_session_id';

  String? _currentSessionId;
  Session? _currentSession;
  String? get currentSessionId => _currentSessionId;
  Session? get currentSession => _currentSession;

  SessionProvider() {
    _init();
  }

  Future<void> _init() async {
    final prefs = await SharedPreferences.getInstance();
    _currentSessionId = prefs.getString(_key);
    if (_currentSessionId != null) {
      _currentSession = await _loadSession(_currentSessionId!);
    }
    if (_currentSession == null) {
      await _ensureActiveSession();
    }
    notifyListeners();
  }

  Future<Session?> _loadSession(String sessionId) async {
    final db = DatabaseHelper();
    final sessions = await db.getSession(sessionId);
    return sessions.isNotEmpty ? Session.fromMap(sessions.first) : null;
  }

  Future<void> _ensureActiveSession() async {
    final db = DatabaseHelper();
    // 查找现有 active session
    final activeSessions = await db.getActiveSession();
    if (activeSessions.isNotEmpty) {
      _currentSession = Session.fromMap(activeSessions.first);
      _currentSessionId = _currentSession!.sessionId;
    } else {
      // 创建新的 active session
      await startNewSession(autoGenerated: true);
    }
    await _saveCurrentSessionId();
    notifyListeners();
  }

  Future<String> getOrCreateSessionId() async {
    if (_currentSessionId == null) {
      await _ensureActiveSession();
    }
    return _currentSessionId!;
  }

  Future<void> startNewSession({String? title, bool autoGenerated = false}) async {
    final db = DatabaseHelper();

    // 关闭当前 session
    if (_currentSessionId != null) {
      await db.closeSession(_currentSessionId!);
    }

    // 创建新 session
    final newSessionId = await Session.generateSessionId();
    final instanceId = await InstanceService.getInstanceId();
    final now = DateTime.now().toUtc();

    final defaultTitle = autoGenerated
        ? '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')} ${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')} 记录'
        : (title ?? '新记录');

    final session = Session(
      sessionId: newSessionId,
      title: defaultTitle,
      status: 'active',
      createdAt: now.toIso8601String(),
      updatedAt: now.toIso8601String(),
      sourceDeviceId: instanceId,
    );

    await db.insertSession(session);
    _currentSessionId = newSessionId;
    _currentSession = session;
    await _saveCurrentSessionId();
    notifyListeners();
  }

  Future<void> _saveCurrentSessionId() async {
    final prefs = await SharedPreferences.getInstance();
    if (_currentSessionId != null) {
      await prefs.setString(_key, _currentSessionId!);
    }
  }
}
```

- [ ] **Step 2: DatabaseHelper 增加 sessions 操作方法**

```dart
// 在 database_helper.dart 中增加

Future<Map<String, dynamic>?> getSessionById(String sessionId) async {
  final db = await database;
  final rows = await db.query(
    _sessionsTable,
    where: 'session_id = ? AND deleted_at IS NULL',
    whereArgs: [sessionId],
    limit: 1,
  );
  return rows.isEmpty ? null : rows.first;
}

Future<List<Map<String, dynamic>>> getActiveSession() async {
  final db = await database;
  return db.query(
    _sessionsTable,
    where: 'status = ? AND deleted_at IS NULL',
    whereArgs: ['active'],
    limit: 1,
  );
}

Future<List<Map<String, dynamic>>> getClosedSessions() async {
  final db = await database;
  return db.query(
    _sessionsTable,
    where: "status IN ('closed', 'archived') AND deleted_at IS NULL",
    orderBy: 'created_at DESC',
  );
}

Future<void> insertSession(Session session) async {
  final db = await database;
  await db.insert(_sessionsTable, session.toMap());
}

Future<void> closeSession(String sessionId) async {
  final db = await database;
  final now = DateTime.now().toUtc().toIso8601String();
  await db.update(
    _sessionsTable,
    {
      'status': 'closed',
      'closed_at': now,
      'updated_at': now,
    },
    where: 'session_id = ?',
    whereArgs: [sessionId],
  );
}

Future<List<Map<String, dynamic>>> getSessionsChangedSince(String since) async {
  final db = await database;
  return db.query(
    _sessionsTable,
    where: 'updated_at > ? OR deleted_at > ?',
    whereArgs: [since, since],
  );
}

Future<void> upsertSessionFromSync(Map<String, dynamic> data) async {
  final sessionId = data['session_id']?.toString();
  if (sessionId == null) return;

  await _upsertSyncRow(
    tableName: _sessionsTable,
    syncId: sessionId,
    incomingRow: data,
  );
}

Future<void> softDeleteSession(String sessionId, String deletedAt) async {
  await _softDeleteBySyncId(_sessionsTable, sessionId, deletedAt);
}
```

### Task 14: LogProvider 改造（clearAllLogs → startNewSession）

**Files:**
- Modify: `lib/providers/log_provider.dart`

- [ ] **Step 1: 修改 clearAllLogs 方法**

```dart
// 替换原有的 clearAllLogs()
Future<void> clearAllLogs() async {
  if (_logs.isEmpty) return;
  // 不再创建 history 快照
  // 不再软删除所有 logs
  // 改为触发 startNewSession，由 SessionProvider 处理
  _logs.clear();
  notifyListeners();
  await _notifyDataChanged();
}
```

> 实际清空逻辑由 SessionProvider.startNewSession 处理（关闭旧 session + 创建新 session，不删除任何日志）

- [ ] **Step 2: addLog 自动写入 session_id**

```dart
Future<void> addLog(LogEntry log, String sessionId) async {
  final db = DatabaseHelper();
  final logWithSession = log.copyWith(sessionId: sessionId);
  final localId = await db.insertLog(logWithSession);
  // ... rest of method
}
```

### Task 15: SyncProvider 增加 sessions

**Files:**
- Modify: `lib/providers/sync_provider.dart`

- [ ] **Step 1: _collectBidirectionalPayload 增加 sessions**

```dart
// 在 _collectBidirectionalPayload 中增加
final sessions = await db.getSessionsChangedSince(since);

return {
  'sessions': sessions,
  'logs': ...,
  'dictionaries': ...,
  'callsignQthHistory': ...,
  // 暂时保留 history 用于向后兼容
  'history': history.map((row) => _normalizeHistoryPayload(row)).toList(),
};
```

- [ ] **Step 2: 同步请求增加 clientInstanceId 和 currentSessionId**

```dart
final instanceId = await InstanceService.getInstanceId();

final body = json.encode({
  'deviceId': _settings.deviceId,
  'clientInstanceId': instanceId,
  'currentSessionId': sessionProvider.currentSessionId,
  'lastSyncAt': _lastSyncAtValue(),
  'payload': payload,
});
```

- [ ] **Step 3: _applyBidirectionalChanges 增加 sessions**

```dart
// 在 _applyBidirectionalChanges 最前面增加
final sessions = List<Map<String, dynamic>>.from(changes['sessions'] ?? const []);
for (final item in sessions) {
  final normalized = _normalizeIncomingSyncItem(item);
  final sessionId = normalized['session_id']?.toString();
  final deletedAt = normalized['deleted_at']?.toString();
  if (sessionId == null) continue;
  if (deletedAt != null) {
    await db.softDeleteSession(sessionId, deletedAt);
  } else {
    await db.upsertSessionFromSync(normalized);
  }
}
```

### Task 16: 历史迁移（客户端）

**Files:**
- Modify: `lib/database/database_helper.dart`

- [ ] **Step 1: 增加迁移方法**

```dart
Future<void> migrateHistoryToSessions() async {
  final db = await database;

  // 检查是否已迁移
  final migrated = await db.rawQuery(
    "SELECT COUNT(*) as cnt FROM $_sessionsTable",
  );
  if (Sqflite.firstIntValue(migrated) != null &&
      Sqflite.firstIntValue(migrated)! > 0) {
    return; // 已有 sessions，跳过迁移
  }

  final histories = await db.query(_historyTable);

  for (final h in histories) {
    final syncId = h['sync_id']?.toString();
    if (syncId == null) continue;

    final sessionId = Session.migrationSessionId(syncId);
    final name = h['name']?.toString() ?? '未命名记录';

    await db.insert(_sessionsTable, {
      'session_id': sessionId,
      'title': name,
      'status': 'closed',
      'created_at': h['created_at'] ?? DateTime.now().toUtc().toIso8601String(),
      'updated_at': h['updated_at'] ?? h['created_at'] ?? DateTime.now().toUtc().toIso8601String(),
      'closed_at': h['created_at'] ?? DateTime.now().toUtc().toIso8601String(),
    });
  }
}
```

- [ ] **Step 2: 在 _onOpen 中触发迁移**

```dart
await _migrateHistoryToSessions(db);
```

### Task 17: main.dart 注册 SessionProvider

**Files:**
- Modify: `lib/main.dart`

- [ ] **Step 1: 在 MultiProvider 中增加 SessionProvider**

```dart
ChangeNotifierProvider(create: (_) => SessionProvider()),
```

### Task 18: 依赖更新

**Files:**
- Modify: `pubspec.yaml`

- [ ] **Step 1: 添加 crypto 依赖**

```yaml
dependencies:
  crypto: ^3.0.3
```

```bash
flutter pub get
```

---

## 验证清单

- [ ] 服务端 `POST /sync/bidirectional` 接受 sessions + logs 并先处理 sessions
- [ ] 服务端 `POST /sync/push` 接受 sessions
- [ ] 服务端 `GET /sync/pull` 返回 sessions
- [ ] 客户端首次启动自动生成 client_instance_id
- [ ] 客户端创建新日志自动写入 session_id
- [ ] 客户端 clearAllLogs 关闭旧 session + 创建新 session（不删除日志）
- [ ] 旧 history 迁移为 closed sessions
- [ ] 客户端同步发送 sessions + clientInstanceId + currentSessionId
- [ ] 客户端收到服务端 sessions 正确 upsert
- [ ] 两端 session_id 对同一 history 记录一致（确定性生成）
- [ ] 诊断 lsp_diagnostics 零错误
- [ ] `npm run dev` 启动无错误
- [ ] `flutter analyze` 无新增错误
