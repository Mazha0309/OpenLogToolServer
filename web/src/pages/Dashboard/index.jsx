import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Table, Tag, Tabs, Button, Modal, Form, Input, Select, message, Space } from 'antd';
import { FileTextOutlined, MobileOutlined, SyncOutlined, UserOutlined } from '@ant-design/icons';
import { getStats, getSyncLogs, getUsers, createUser, deleteUser } from '../../services/admin';
import { getShares, createShare, deleteShare } from '../../services/share';
import dayjs from 'dayjs';

const { TabPane } = Tabs;

function Dashboard() {
  const [stats, setStats] = useState({
    totalLogs: 0,
    totalDevices: 0,
    todayLogs: 0,
    weekLogs: 0,
  });
  const [syncLogs, setSyncLogs] = useState([]);
  const [users, setUsers] = useState([]);
  const [shares, setShares] = useState([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [form] = Form.useForm();
  const [activeTab, setActiveTab] = useState('overview');

  const userStr = localStorage.getItem('user');
  const currentUser = userStr ? JSON.parse(userStr) : null;

  useEffect(() => {
    loadStats();
    loadSyncLogs();
    loadUsers();
    loadShares();
  }, []);

  const loadStats = async () => {
    try {
      const result = await getStats();
      if (result.success) {
        setStats(result.data);
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  };

  const loadSyncLogs = async () => {
    try {
      const result = await getSyncLogs(10);
      if (result.success) {
        setSyncLogs(result.data);
      }
    } catch (error) {
      console.error('Failed to load sync logs:', error);
    }
  };

  const loadUsers = async () => {
    try {
      const res = await getUsers();
      if (res.success) {
        setUsers(res.data || []);
      }
    } catch (_) {}
  };

  const loadShares = async () => {
    try {
      const res = await getShares();
      if (res.success) {
        setShares(res.data || []);
      }
    } catch (_) {}
  };

  const handleCreateUser = async (values) => {
    try {
      const res = await createUser(values);
      if (res.success) {
        message.success('子账号创建成功');
        setModalVisible(false);
        form.resetFields();
        loadUsers();
      } else {
        message.error(res.error?.message || '创建失败');
      }
    } catch (_) {
      message.error('创建失败');
    }
  };

  const handleDeleteUser = async (id) => {
    try {
      const res = await deleteUser(id);
      if (res.success) {
        message.success('删除成功');
        loadUsers();
      }
    } catch (_) {
      message.error('删除失败');
    }
  };

  const handleSharingToggle = async (userId, checked, shareType) => {
    if (!checked) {
      const userShares = shares.filter(s => s.fromUserId === userId);
      for (const s of userShares) {
        await deleteShare(s.id);
      }
      loadShares();
      message.success('已关闭共享');
    } else {
      await createShare({ toUserId: userId, shareType, itemIds: null });
      loadShares();
      message.success('已开启共享');
    }
  };

  const getUserSharing = (userId) => {
    return shares.filter(s => s.fromUserId === userId);
  };

  const syncColumns = [
    { title: '设备ID', dataIndex: 'deviceId', key: 'deviceId' },
    { title: '同步类型', dataIndex: 'syncType', key: 'syncType', render: (type) => (
      <Tag color={type === 'push' ? 'blue' : type === 'pull' ? 'green' : 'orange'}>
        {type === 'push' ? '上传' : type === 'pull' ? '拉取' : '双向'}
      </Tag>
    )},
    { title: '记录数', dataIndex: 'recordsCount', key: 'recordsCount' },
    { title: '同步时间', dataIndex: 'syncedAt', key: 'syncedAt', render: (time) => dayjs(time).format('YYYY-MM-DD HH:mm:ss') },
  ];

  const userColumns = [
    { title: '用户名', dataIndex: 'username', key: 'username' },
    { title: '角色', dataIndex: 'role', render: (r) => r === 'admin' ? '管理员' : '子账号' },
    { title: '共享设置', key: 'sharing', render: (_, record) => {
      if (record.role === 'admin') return '-';
      const userShares = getUserSharing(record.id);
      const isSharing = userShares.length > 0;
      const shareType = userShares[0]?.shareType || 'both';
      return (
        <Space>
          <Select
            value={isSharing ? shareType : 'none'}
            onChange={(val) => handleSharingToggle(record.id, val !== 'none', val)}
            style={{ width: 120 }}
            size="small"
          >
            <Select.Option value="none">关闭</Select.Option>
            <Select.Option value="logs">日志</Select.Option>
            <Select.Option value="dictionaries">词典</Select.Option>
            <Select.Option value="both">全部</Select.Option>
          </Select>
        </Space>
      );
    }},
    { title: '操作', key: 'action', render: (_, record) => (
      record.role !== 'admin' ? (
        <Button size="small" danger onClick={() => handleDeleteUser(record.id)}>删除</Button>
      ) : null
    )},
  ];

  const renderOverview = () => (
    <>
      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic title="总日志数" value={stats.totalLogs} prefix={<FileTextOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="今日新增" value={stats.todayLogs} prefix={<FileTextOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="本周新增" value={stats.weekLogs} prefix={<SyncOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="注册设备" value={stats.totalDevices} prefix={<MobileOutlined />} />
          </Card>
        </Col>
      </Row>
      <Card title="最近同步记录" style={{ marginTop: 24 }}>
        <Table columns={syncColumns} dataSource={syncLogs} rowKey="id" pagination={false} />
      </Card>
    </>
  );

  const renderSubAccounts = () => (
    <Card
      title="子账号管理"
      extra={<Button type="primary" icon={<UserOutlined />} onClick={() => { setEditingUser(null); form.resetFields(); setModalVisible(true); }}>创建子账号</Button>}
    >
      <Table
        columns={userColumns}
        dataSource={users.filter(u => u.role !== 'admin')}
        rowKey="id"
        pagination={false}
      />
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
            <Button type="primary" htmlType="submit" block>
              创建
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>仪表板</h1>
      <Tabs activeKey={activeTab} onChange={setActiveTab}>
        <TabPane tab="概览" key="overview">
          {renderOverview()}
        </TabPane>
        <TabPane tab="子账号" key="subaccounts">
          {renderSubAccounts()}
        </TabPane>
      </Tabs>
    </div>
  );
}

export default Dashboard;