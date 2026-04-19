import { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, message, Space, Tabs, List, Tag, Popconfirm, Select } from 'antd';
import { getDictionaries, createDictionary, updateDictionary, deleteDictionary } from '../../services/dictionary';
import { getCallsignQthHistory, addCallsignQthRecord, clearCallsignQthHistory } from '../../services/callsignQth';
import { getUsers } from '../../services/admin';

const { TabPane } = Tabs;
const types = [
  { label: '设备', value: 'device' },
  { label: '天线', value: 'antenna' },
  { label: '位置', value: 'qth' },
  { label: '呼号', value: 'callsign' },
  { label: '呼号-QTH', value: 'callsign_qth' },
];

function Dictionaries() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeType, setActiveType] = useState('device');
  const [modalVisible, setModalVisible] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [form] = Form.useForm();
  const [qthHistory, setQthHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState(null);

  useEffect(() => {
    loadUsers();
  }, []);

  useEffect(() => {
    if (activeType !== 'callsign_qth') {
      loadDictionaries();
    }
  }, [activeType, selectedUserId]);

  const loadUsers = async () => {
    try {
      const result = await getUsers();
      if (result.success) {
        const subAccounts = result.data.filter(u => u.role === 'user');
        setUsers(subAccounts);
      }
    } catch (error) {
      console.error('加载用户失败', error);
    }
  };

  const loadDictionaries = async () => {
    setLoading(true);
    try {
      const params = { type: activeType };
      if (selectedUserId) params.userId = selectedUserId;
      const result = await getDictionaries(params);
      if (result.success) {
        setData(result.data);
      }
    } catch (error) {
      message.error('加载失败');
    } finally {
      setLoading(false);
    }
  };

  const loadQthHistory = async () => {
    setHistoryLoading(true);
    try {
      const result = await getCallsignQthHistory();
      if (result.success) {
        setQthHistory(result.data || []);
      }
    } catch (error) {
      message.error('加载历史失败');
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleTabChange = (key) => {
    setActiveType(key);
    if (key === 'callsign_qth') {
      loadQthHistory();
    }
  };

  const handleAdd = () => {
    setEditingItem(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditingItem(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleDelete = async (id) => {
    try {
      const result = await deleteDictionary(id);
      if (result.success) {
        message.success('删除成功');
        loadDictionaries();
      }
    } catch (error) {
      message.error('删除失败');
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editingItem) {
        await updateDictionary(editingItem.id, values);
      } else {
        await createDictionary(activeType, values);
      }
      message.success(editingItem ? '更新成功' : '创建成功');
      setModalVisible(false);
      loadDictionaries();
    } catch (error) {
      message.error('操作失败');
    }
  };

  const handleClearHistory = async () => {
    try {
      const result = await clearCallsignQthHistory();
      if (result.success) {
        message.success('历史已清空');
        loadQthHistory();
      }
    } catch (error) {
      message.error('清空失败');
    }
  };

  const columns = [
    { title: '原始值', dataIndex: 'raw', key: 'raw' },
    { title: '拼音', dataIndex: 'pinyin', key: 'pinyin' },
    { title: '缩写', dataIndex: 'abbreviation', key: 'abbreviation' },
    { title: '操作', key: 'action', render: (_, record) => (
      <Space>
        <Button size="small" onClick={() => handleEdit(record)}>编辑</Button>
        <Button size="small" danger onClick={() => handleDelete(record.id)}>删除</Button>
      </Space>
    )},
  ];

  const historyColumns = [
    { title: '呼号', dataIndex: 'callsign', key: 'callsign', render: (v) => <Tag color="blue">{v}</Tag> },
    { title: 'QTH', dataIndex: 'qth', key: 'qth' },
    { title: '最后使用时间', dataIndex: 'timestamp', key: 'timestamp', render: (t) => t ? new Date(t).toLocaleString() : '-' },
  ];

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>词典管理</h1>
      <div style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
        <Select
          placeholder="选择子账号查看"
          allowClear
          style={{ width: 200 }}
          value={selectedUserId}
          onChange={(value) => {
            setSelectedUserId(value);
          }}
          options={users.map(u => ({ label: u.username, value: u.id }))}
        />
        <span style={{ color: '#888', fontSize: 12 }}>
          {selectedUserId ? '查看子账号数据' : '查看所有数据'}
        </span>
      </div>
      <Tabs activeKey={activeType} onChange={handleTabChange}>
        {types.map(t => (
          <TabPane key={t.value} tab={t.label}>
            {t.value === 'callsign_qth' ? (
              <div>
                <Space style={{ marginBottom: 16 }}>
                  <Button onClick={loadQthHistory}>刷新</Button>
                  <Popconfirm
                    title="确定要清空所有历史记录吗？"
                    onConfirm={handleClearHistory}
                    okText="确定"
                    cancelText="取消"
                  >
                    <Button danger>清空历史</Button>
                  </Popconfirm>
                </Space>
                <Table
                  columns={historyColumns}
                  dataSource={qthHistory}
                  loading={historyLoading}
                  rowKey="id"
                  pagination={{ pageSize: 50 }}
                />
              </div>
            ) : (
              <>
                <Button type="primary" onClick={handleAdd} style={{ marginBottom: 16 }}>添加</Button>
                <Table
                  columns={columns}
                  dataSource={data}
                  loading={loading}
                  rowKey="id"
                  pagination={{ pageSize: 50 }}
                />
              </>
            )}
          </TabPane>
        ))}
      </Tabs>
      <Modal
        title={editingItem ? '编辑词典' : '添加词典'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="原始值" name="raw" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="拼音" name="pinyin">
            <Input />
          </Form.Item>
          <Form.Item label="缩写" name="abbreviation">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default Dictionaries;