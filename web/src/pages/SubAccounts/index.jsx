import { useEffect, useState } from 'react';
import { Table, Button, Card, Modal, Form, Input, Select, message, Space, Tag } from 'antd';
import { getUsers, createUser, deleteUser } from '../../services/admin';
import { getShares, createShare, deleteShare } from '../../services/share';

function SubAccounts() {
  const [users, setUsers] = useState([]);
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadUsers();
    loadShares();
  }, []);

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

  const handleSharingChange = async (userId, shareType) => {
    try {
      const existingShares = shares.filter(s => s.fromUserId === userId);
      for (const s of existingShares) {
        await deleteShare(s.id);
      }
      if (shareType !== 'none') {
        await createShare({ toUserId: userId, shareType, itemIds: null });
      }
      loadShares();
      message.success('共享设置已更新');
    } catch (error) {
      message.error('设置失败');
    }
  };

  const getUserShareType = (userId) => {
    const userShares = shares.filter(s => s.fromUserId === userId);
    if (userShares.length === 0) return 'none';
    return userShares[0].shareType;
  };

  const columns = [
    { title: '用户名', dataIndex: 'username', key: 'username' },
    { title: '角色', dataIndex: 'role', render: (r) => <Tag color={r === 'admin' ? 'blue' : 'green'}>{r === 'admin' ? '管理员' : '子账号'}</Tag> },
    {
      title: '共享设置',
      key: 'sharing',
      render: (_, record) => {
        if (record.role === 'admin') return '-';
        return (
          <Select
            value={getUserShareType(record.id)}
            onChange={(val) => handleSharingChange(record.id, val)}
            style={{ width: 120 }}
            size="small"
          >
            <Select.Option value="none">关闭</Select.Option>
            <Select.Option value="logs">日志</Select.Option>
            <Select.Option value="dictionaries">词典</Select.Option>
            <Select.Option value="both">全部</Select.Option>
          </Select>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => {
        if (record.role === 'admin') return '-';
        return (
          <Button size="small" danger onClick={() => handleDeleteUser(record.id)}>
            删除
          </Button>
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
    </div>
  );
}

export default SubAccounts;