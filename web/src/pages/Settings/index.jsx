import { useState, useEffect } from 'react';
import { Card, Switch, Button, message, Space, Table, Modal, Form, Input } from 'antd';

function Settings({ darkMode, onDarkModeChange }) {
  const [users, setUsers] = useState([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  const userStr = localStorage.getItem('user');
  const currentUser = userStr ? JSON.parse(userStr) : null;
  const isAdmin = currentUser?.role === 'admin';

  useEffect(() => {
    if (isAdmin) {
      loadUsers();
    }
  }, [isAdmin]);

  const loadUsers = async () => {
    try {
      const res = await fetch('http://localhost:3000/api/v1/admin/users', {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      const data = await res.json();
      if (data.success) {
        setUsers(data.data || []);
      }
    } catch (_) {}
  };

  const handleThemeChange = (checked) => {
    onDarkModeChange?.(checked);
    localStorage.setItem('theme', checked ? 'dark' : 'light');
    message.success(`已切换到${checked ? '深色' : '浅色'}模式`);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    window.location.reload();
  };

  const handleCreateSubAccount = async (values) => {
    setLoading(true);
    try {
      const res = await fetch('http://localhost:3000/api/v1/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (data.success) {
        message.success('子账号创建成功');
        setModalVisible(false);
        form.resetFields();
        loadUsers();
      } else {
        message.error(data.error?.message || '创建失败');
      }
    } catch (_) {
      message.error('创建失败');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async (id) => {
    try {
      const res = await fetch(`http://localhost:3000/api/v1/admin/users/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      const data = await res.json();
      if (data.success) {
        message.success('删除成功');
        loadUsers();
      }
    } catch (_) {
      message.error('删除失败');
    }
  };

  const columns = [
    { title: '用户名', dataIndex: 'username' },
    { title: '角色', dataIndex: 'role', render: (r) => (r === 'admin' ? '管理员' : '用户') },
    {
      title: '操作',
      render: (_, record) => {
        if (record.id === currentUser?.id) return null;
        return (
          <Button size="small" danger onClick={() => handleDeleteUser(record.id)}>
            删除
          </Button>
        );
      },
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>系统设置</h1>

      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Card title="外观设置">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>深色模式</span>
            <Switch checked={darkMode} onChange={handleThemeChange} />
          </div>
        </Card>

        {isAdmin && (
          <Card
            title="子账号管理"
            extra={<Button type="primary" size="small" onClick={() => setModalVisible(true)}>创建子账号</Button>}
          >
            <Table
              columns={columns}
              dataSource={users.filter(u => u.id !== currentUser?.id)}
              rowKey="id"
              size="small"
              pagination={false}
            />
          </Card>
        )}

        <Card title="数据同步">
          <p>服务器已连接</p>
        </Card>

        <Card title="账号安全">
          <Button onClick={handleLogout} danger>
            退出登录
          </Button>
        </Card>
      </Space>

      <Modal
        title="创建子账号"
        open={modalVisible}
        onCancel={() => { setModalVisible(false); form.resetFields(); }}
        footer={null}
      >
        <Form form={form} layout="vertical" onFinish={handleCreateSubAccount}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="请输入用户名" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="请输入密码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>
              创建
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default Settings;
