# 子账号选择性共享功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 管理员可为子账号配置细粒度数据共享，选择具体日志/词典/历史分享给指定子账号

**架构：**
- 修改 shares 表结构支持 item_ids 和 auto_sync
- 新增 Admin Share API 支持细粒度配置
- 改造子账号管理页面 UI，添加共享配置弹窗

**技术栈：** Node.js/Express, React/Ant Design, MySQL/MongoDB/Memory Adapters

---

## 文件结构

```
src/
├── api/routes/
│   └── admin.js          # 新增 /admin/shares/* 端点
├── services/
│   └── index.js          # ShareService 增强
├── database/
│   ├── adapters/
│   │   ├── memory.js    # shares 表支持 item_ids
│   │   ├── mysql.js     # shares 表 ALTER
│   │   └── mongodb.js   # shares schema 更新
│   └── repository.js     # ShareRepository 增强
web/src/
├── pages/SubAccounts/
│   └── index.jsx         # 添加共享配置弹窗
├── services/
│   └── share.js          # 新增 admin share API 调用
```

---

## Task 1: 修改数据库 Shares 表结构

**Files:**
- Modify: `src/database/adapters/mysql.js`
- Modify: `src/database/adapters/mongodb.js`
- Modify: `src/database/adapters/memory.js`
- Modify: `src/database/repository.js`

- [ ] **Step 1: MySQL - 给 shares 表添加 item_ids 和 auto_sync 字段**

在 MySQL adapter 的 `initTables` 方法中，找到 createSharesTable，修改为：

```javascript
const createSharesTable = `
  CREATE TABLE IF NOT EXISTS shares (
    id VARCHAR(36) PRIMARY KEY,
    from_user_id VARCHAR(36) NOT NULL,
    to_user_id VARCHAR(36) NOT NULL,
    share_type ENUM('logs', 'dictionaries', 'history', 'both') NOT NULL,
    status ENUM('active', 'inactive') DEFAULT 'active',
    item_ids JSON,
    auto_sync BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_from_user (from_user_id),
    INDEX idx_to_user (to_user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;
```

- [ ] **Step 2: MongoDB - 更新 shareSchema**

在 Mongodb adapter 中，更新 shareSchema：

```javascript
const shareSchema = new mongoose.Schema({
  fromUserId: { type: String, required: true, index: true },
  toUserId: { type: String, required: true, index: true },
  shareType: { type: String, enum: ['logs', 'dictionaries', 'history', 'both'], required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  itemIds: { type: [String], default: null },
  autoSync: { type: Boolean, default: false },
}, {
  timestamps: true,
  collection: 'shares',
});
```

- [ ] **Step 3: Memory - 更新 shares 存储结构**

Memory adapter 的 shares 数组项添加 `itemIds` 和 `autoSync` 字段。

- [ ] **Step 4: Repository - 更新 ShareRepository 方法**

`findByFromUser` 和 `findByToUser` 返回项添加 `itemIds` 和 `autoSync` 字段。

---

## Task 2: 更新 ShareService 支持细粒度共享

**Files:**
- Modify: `src/services/index.js`

- [ ] **Step 1: 在 ShareService 中新增方法**

```javascript
async getSharesByUser(userId) {
  return this.shareRepo.findAllByUser(userId);
}

async updateShareConfig(fromUserId, shareType, itemIds, toUserIds, autoSync) {
  const adapter = await connector.connect();
  const shareRepo = new ShareRepository(adapter);

  for (const toUserId of toUserIds) {
    const existing = await shareRepo.findByFromAndTo(fromUserId, toUserId);
    if (existing) {
      await shareRepo.update(existing.id, { shareType, itemIds, autoSync });
    } else {
      await shareRepo.create({
        fromUserId,
        toUserId,
        shareType,
        itemIds,
        autoSync,
      });
    }
  }

  for (const share of await shareRepo.findByFromUser(fromUserId)) {
    if (!toUserIds.includes(share.toUserId)) {
      await shareRepo.delete(share.id);
    }
  }
}
```

- [ ] **Step 2: 更新 findLogsSharedTo 和 findDictionariesSharedTo 支持 itemIds 过滤**

```javascript
async listLogsSharedTo(userId) {
  const shares = await this.shareRepo.findByToUser(userId);
  const logs = [];
  for (const share of shares) {
    if (share.shareType === 'logs' || share.shareType === 'both') {
      const items = share.itemIds ? share.itemIds : null;
      const sharedLogs = await this.logRepo.findSharedLogs(share.fromUserId, userId, items);
      logs.push(...sharedLogs.map(l => ({ ...l, sharedBy: share.fromUserId })));
    }
  }
  return logs;
}
```

---

## Task 3: 新增 Admin Share API 端点

**Files:**
- Modify: `src/api/routes/admin.js`
- Modify: `web/src/services/share.js`

- [ ] **Step 1: Admin API - 获取用户共享配置**

```javascript
router.get('/shares/:userId', adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const shares = await shareService.getSharesByUser(userId);
    res.json({ success: true, data: shares });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});
```

- [ ] **Step 2: Admin API - 更新共享配置**

```javascript
router.put('/shares/:userId', adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { shareType, itemIds, toUserIds, autoSync } = req.body;
    await shareService.updateShareConfig(userId, shareType, itemIds, toUserIds, autoSync);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});
```

- [ ] **Step 3: Web - 添加 share service 方法**

```javascript
export async function getAdminShareConfig(userId) {
  return api.get(`/admin/shares/${userId}`);
}

export async function updateAdminShareConfig(userId, data) {
  return api.put(`/admin/shares/${userId}`, data);
}
```

---

## Task 4: 实现共享数据查询接口

**Files:**
- Modify: `src/api/routes/shares.js`

- [ ] **Step 1: 更新 GET /shared-logs 支持 itemIds 过滤**

获取共享日志时，如果 share.itemIds 不为空，只返回指定ID的日志。

- [ ] **Step 2: 更新 GET /shared-dictionaries 支持 itemIds 过滤**

获取共享词典时，如果 share.itemIds 不为空，只返回指定ID的词典。

---

## Task 5: 改造子账号管理页面 UI

**Files:**
- Modify: `web/src/pages/SubAccounts/index.jsx`
- Modify: `web/src/services/admin.js`

- [ ] **Step 1: 添加共享配置弹窗状态**

```javascript
const [shareModalVisible, setShareModalVisible] = useState(false);
const [selectedUser, setSelectedUser] = useState(null);
const [shareConfig, setShareConfig] = useState({ shareType: 'logs', itemIds: [], toUserIds: [], autoSync: false });
```

- [ ] **Step 2: 添加操作列按钮**

```javascript
{
  title: '操作',
  key: 'action',
  render: (_, record) => (
    <Space>
      <Button size="small" onClick={() => openShareModal(record)}>配置共享</Button>
      <Button size="small" danger onClick={() => handleDeleteUser(record.id)}>删除</Button>
    </Space>
  ),
}
```

- [ ] **Step 3: 实现 openShareModal 方法**

```javascript
const openShareModal = async (user) => {
  setSelectedUser(user);
  const result = await getAdminShareConfig(user.id);
  if (result.success) {
    const config = result.data[0] || { shareType: 'logs', itemIds: [], toUserIds: [], autoSync: false };
    setShareConfig(config);
  } else {
    setShareConfig({ shareType: 'logs', itemIds: [], toUserIds: [], autoSync: false });
  }
  setShareModalVisible(true);
};
```

- [ ] **Step 4: 添加共享配置弹窗组件**

```jsx
<Modal
  title={`配置共享 - ${selectedUser?.username}`}
  open={shareModalVisible}
  onCancel={() => setShareModalVisible(false)}
  footer={null}
  width={700}
>
  <Tabs defaultActiveKey="logs">
    <TabPane tab="日志" key="logs">
      <Checkbox onChange={(e) => setShareConfig({
        ...shareConfig,
        itemIds: e.target.checked ? [] : [],
        autoSync: e.target.checked
      })}>
        全选 + 新增自动共享
      </Checkbox>
      <Table
        dataSource={logsData}
        columns={logColumns}
        rowSelection={{
          selectedRowKeys: shareConfig.itemIds,
          onChange: (keys) => setShareConfig({...shareConfig, itemIds: keys})
        }}
        pagination={{ pageSize: 10 }}
      />
    </TabPane>
    <TabPane tab="词典" key="dictionaries">
      <Checkbox>全选 + 新增自动共享</Checkbox>
      <Table ... />
    </TabPane>
    <TabPane tab="历史" key="history">
      <Checkbox>全选 + 新增自动共享</Checkbox>
      <Table ... />
    </TabPane>
  </Tabs>

  <div style={{ marginTop: 16 }}>
    <h4>共享给:</h4>
    <Checkbox.Group
      options={otherUsers.map(u => ({ label: u.username, value: u.id }))}
      value={shareConfig.toUserIds}
      onChange={(values) => setShareConfig({...shareConfig, toUserIds: values})}
    />
  </div>

  <div style={{ marginTop: 16, textAlign: 'right' }}>
    <Button onClick={() => setShareModalVisible(false)}>取消</Button>
    <Button type="primary" style={{ marginLeft: 8 }} onClick={handleSaveShareConfig}>保存</Button>
  </div>
</Modal>
```

- [ ] **Step 5: 实现 handleSaveShareConfig 方法**

```javascript
const handleSaveShareConfig = async () => {
  try {
    const result = await updateAdminShareConfig(selectedUser.id, shareConfig);
    if (result.success) {
      message.success('共享配置已保存');
      setShareModalVisible(false);
    }
  } catch (error) {
    message.error('保存失败');
  }
};
```

---

## Task 6: 验证与测试

- [ ] **Step 1: 启动服务器验证 API**

```bash
curl -X GET http://localhost:3000/api/v1/admin/shares/:userId
curl -X PUT http://localhost:3000/api/v1/admin/shares/:userId \
  -H "Content-Type: application/json" \
  -d '{"shareType":"logs","itemIds":["id1"],"toUserIds":["userId2"],"autoSync":true}'
```

- [ ] **Step 2: Web UI 测试**

访问子账号管理页面，点击"配置共享"按钮，验证弹窗显示正常。

- [ ] **Step 3: Flutter App 测试**

用子账号登录，验证能看到共享过来的数据。
