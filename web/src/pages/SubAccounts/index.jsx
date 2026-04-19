import { useEffect, useState } from 'react';
import { Table, Button, Card, Modal, Form, Input, Select, message, Space, Tag, Tabs, Checkbox } from 'antd';
import { getUsers, createUser, deleteUser } from '../../services/admin';
import { getShares, createShare, deleteShare, getAdminShareConfig, updateAdminShareConfig } from '../../services/share';
import { getAdminLogs, getAdminDictionaries } from '../../services/admin';

const { TabPane } = Tabs;

function SubAccounts() {
  const [users, setUsers] = useState([]);
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [shareConfig, setShareConfig] = useState({ logs: [], dictionaries: [], history: [] });
  const [selectedLogs, setSelectedLogs] = useState([]);
  const [selectedDictionaries, setSelectedDictionaries] = useState([]);
  const [selectedHistory, setSelectedHistory] = useState([]);
  const [selectAllLogs, setSelectAllLogs] = useState(false);
  const [selectAllDictionaries, setSelectAllDictionaries] = useState(false);
  const [selectAllHistory, setSelectAllHistory] = useState(false);
  const [targetUsers, setTargetUsers] = useState([]);
  const [form] = Form.useForm();

  useEffect(() => {
    loadUsers();
    loadShares();
  }, []);

  useEffect(() => {
    if (shareModalVisible) {
      loadTargetUsers();
    }
  }, [shareModalVisible]);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const result = await getUsers();
      if (result.success) {
        setUsers(result.data || []);
      }
    } catch (error) {
      console.error('Failed to load users:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadShares = async () => {
    try {
      const result = await getShares();
      if (result.success) {
        setShares(result.data || []);
      }
    } catch (error) {
      console.error('Failed to load shares:', error);
    }
  };

  const loadTargetUsers = () => {
    const subAccounts = users.filter(u => u.role !== 'admin' && u.id !== selectedUser?.id);
    setTargetUsers(subAccounts);
  };

  const handleCreateUser = async (values) => {
    try {
      const result = await createUser(values);
      if (result.success) {
        message.success('子账号创建成功');
        setModalVisible(false);
        form.resetFields();
        loadUsers();
      } else {
        message.error(result.error?.message || '创建失败');
      }
    } catch (error) {
      message.error('创建失败');
    }
  };

  const handleDeleteUser = async (id) => {
    try {
      const result = await deleteUser(id);
      if (result.success) {
        message.success('删除成功');
        loadUsers();
      }
    } catch (error) {
      message.error('删除失败');
    }
  };

  const openShareModal = async (record) => {
    setSelectedUser(record);
    try {
      const result = await getAdminShareConfig(record.id);
      if (result.success && result.data) {
        const config = result.data;
        setShareConfig(prev => ({
          ...prev,
          shareSettings: config.shareSettings || {},
        }));
        setSelectedLogs(config.itemIds?.logs || []);
        setSelectedDictionaries(config.itemIds?.dictionaries || []);
        setSelectedHistory(config.itemIds?.history || []);
        setSelectAllLogs(config.autoSync?.logs || false);
        setSelectAllDictionaries(config.autoSync?.dictionaries || false);
        setSelectAllHistory(config.autoSync?.history || false);
      }
      const logsResult = await getAdminLogs({ userId: record.id, pageSize: 100 });
      const deviceDictsResult = await getAdminDictionaries({ userId: record.id, type: 'device' });
      const antennaDictsResult = await getAdminDictionaries({ userId: record.id, type: 'antenna' });
      const qthDictsResult = await getAdminDictionaries({ userId: record.id, type: 'qth' });
      const callsignDictsResult = await getAdminDictionaries({ userId: record.id, type: 'callsign' });

      if (logsResult.success) {
        setShareConfig(prev => ({ ...prev, logs: logsResult.data?.data || [] }));
      }

      const allDicts = [
        ...(deviceDictsResult.data?.data || []).map(d => ({ ...d, type: 'device' })),
        ...(antennaDictsResult.data?.data || []).map(d => ({ ...d, type: 'antenna' })),
        ...(qthDictsResult.data?.data || []).map(d => ({ ...d, type: 'qth' })),
        ...(callsignDictsResult.data?.data || []).map(d => ({ ...d, type: 'callsign' })),
      ];
      setShareConfig(prev => ({ ...prev, dictionaries: allDicts }));
    } catch (error) {
      console.error('Failed to load share config:', error);
    }
    setShareModalVisible(true);
  };

  const handleSaveShareConfig = async () => {
    if (!selectedUser) return;
    try {
      const toUserIds = Object.entries(shareConfig.shareSettings || {})
        .filter(([_, v]) => v.enabled)
        .map(([k]) => k);

      const data = {
        shareType: 'both',
        itemIds: {
          logs: selectAllLogs ? [] : selectedLogs,
          dictionaries: selectAllDictionaries ? [] : selectedDictionaries,
          history: selectAllHistory ? [] : selectedHistory,
        },
        autoSync: {
          logs: selectAllLogs,
          dictionaries: selectAllDictionaries,
          history: selectAllHistory,
        },
        toUserIds,
      };
      const result = await updateAdminShareConfig(selectedUser.id, data);
      if (result.success) {
        message.success('共享配置已保存');
        setShareModalVisible(false);
      } else {
        message.error(result.error?.message || '保存失败');
      }
    } catch (error) {
      message.error('保存失败');
    }
  };

  const logColumns = [
    { title: '设备', dataIndex: 'device', key: 'device' },
    { title: '控制员', dataIndex: 'controller', key: 'controller' },
    { title: '呼号', dataIndex: 'callsign', key: 'callsign' },
    { title: '报告', dataIndex: 'report', key: 'report' },
    { title: 'QTH', dataIndex: 'qth', key: 'qth' },
    { title: '时间', dataIndex: 'time', key: 'time', render: (t) => t ? new Date(t).toLocaleString() : '-' },
  ];

  const dictionaryColumns = [
    { title: '类型', dataIndex: 'type', key: 'type' },
    { title: '原始值', dataIndex: 'raw', key: 'raw' },
    { title: '拼音', dataIndex: 'pinyin', key: 'pinyin' },
  ];

  const historyColumns = [
    { title: '内容', dataIndex: 'content', key: 'content', ellipsis: true },
    { title: '时间', dataIndex: 'timestamp', key: 'timestamp', render: (t) => t ? new Date(t).toLocaleString() : '-' },
  ];

  const columns = [
    { title: '用户名', dataIndex: 'username', key: 'username' },
    { title: '角色', dataIndex: 'role', render: (r) => <Tag color={r === 'admin' ? 'blue' : 'green'}>{r === 'admin' ? '管理员' : '子账号'}</Tag> },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => {
        if (record.role === 'admin') return '-';
        return (
          <Space>
            <Button size="small" onClick={() => openShareModal(record)}>配置共享</Button>
            <Button size="small" danger onClick={() => handleDeleteUser(record.id)}>删除</Button>
          </Space>
        );
      },
    },
  ];

  const subAccounts = users.filter(u => u.role !== 'admin');

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>子账号管理</h1>
      <Card
        extra={
          <Button type="primary" onClick={() => { setModalVisible(true); form.resetFields(); }}>
            创建子账号
          </Button>
        }
      >
        <Table
          columns={columns}
          dataSource={subAccounts}
          rowKey="id"
          loading={loading}
          pagination={false}
        />
      </Card>

      <Modal
        title="创建子账号"
        open={modalVisible}
        onCancel={() => { setModalVisible(false); form.resetFields(); }}
        footer={null}
      >
        <Form form={form} layout="vertical" onFinish={handleCreateUser}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="请输入用户名" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="请输入密码" />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" block>
                创建
              </Button>
              <Button onClick={() => setModalVisible(false)}>取消</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`配置共享 - ${selectedUser?.username || ''}`}
        open={shareModalVisible}
        onCancel={() => setShareModalVisible(false)}
        onOk={handleSaveShareConfig}
        width={800}
        okText="保存"
        cancelText="取消"
      >
        <div style={{ marginBottom: 16 }}>
          <span style={{ fontWeight: 500 }}>共享给：</span>
          <Checkbox.Group
            options={targetUsers.map(u => ({ label: u.username, value: u.id }))}
            value={Object.entries(shareConfig.shareSettings || {})
              .filter(([_, v]) => v?.enabled)
              .map(([k]) => k)}
            onChange={(values) => {
              const newSettings = {};
              targetUsers.forEach(u => {
                newSettings[u.id] = { enabled: values.includes(u.id) };
              });
              setShareConfig(prev => ({ ...prev, shareSettings: newSettings }));
            }}
          />
        </div>
        <Tabs defaultActiveKey="logs">
          <TabPane key="logs" tab="日志">
            <div style={{ marginBottom: 12 }}>
              <Checkbox
                checked={selectAllLogs}
                onChange={(e) => {
                  setSelectAllLogs(e.target.checked);
                  if (e.target.checked) {
                    setSelectedLogs([]);
                  }
                }}
              >
                全选
              </Checkbox>
            </div>
            <Table
              columns={logColumns}
              dataSource={shareConfig.logs}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10 }}
              rowSelection={{
                selectedRowKeys: selectedLogs,
                onChange: (keys) => {
                  if (!selectAllLogs) {
                    setSelectedLogs(keys);
                  }
                },
                getCheckboxProps: () => ({ disabled: selectAllLogs }),
              }}
            />
          </TabPane>
          <TabPane key="dictionaries" tab="词典">
            <div style={{ marginBottom: 12 }}>
              <Checkbox
                checked={selectAllDictionaries}
                onChange={(e) => {
                  setSelectAllDictionaries(e.target.checked);
                  if (e.target.checked) {
                    setSelectedDictionaries([]);
                  }
                }}
              >
                全选
              </Checkbox>
            </div>
            <Table
              columns={dictionaryColumns}
              dataSource={shareConfig.dictionaries}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10 }}
              rowSelection={{
                selectedRowKeys: selectedDictionaries,
                onChange: (keys) => {
                  if (!selectAllDictionaries) {
                    setSelectedDictionaries(keys);
                  }
                },
                getCheckboxProps: () => ({ disabled: selectAllDictionaries }),
              }}
            />
          </TabPane>
          <TabPane key="history" tab="历史">
            <div style={{ marginBottom: 12 }}>
              <Checkbox
                checked={selectAllHistory}
                onChange={(e) => {
                  setSelectAllHistory(e.target.checked);
                  if (e.target.checked) {
                    setSelectedHistory([]);
                  }
                }}
              >
                全选
              </Checkbox>
            </div>
            <Table
              columns={historyColumns}
              dataSource={shareConfig.history}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10 }}
              rowSelection={{
                selectedRowKeys: selectedHistory,
                onChange: (keys) => {
                  if (!selectAllHistory) {
                    setSelectedHistory(keys);
                  }
                },
                getCheckboxProps: () => ({ disabled: selectAllHistory }),
              }}
            />
          </TabPane>
        </Tabs>
      </Modal>
    </div>
  );
}

export default SubAccounts;
