import { useEffect, useState } from 'react';
import { Table, Button, Card, Tabs, Tag, Space, Popconfirm, Switch, message } from 'antd';
import { getAllShares, deleteShareById, getPublicLinks, deletePublicLink, togglePublicLink, getUsers } from '../../services/admin';
import dayjs from 'dayjs';

const { TabPane } = Tabs;

function Shares() {
  const [shares, setShares] = useState([]);
  const [links, setLinks] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [sharesRes, linksRes, usersRes] = await Promise.all([
        getAllShares(),
        getPublicLinks(),
        getUsers(),
      ]);
      if (sharesRes.success) setShares(sharesRes.data || []);
      if (linksRes.success) setLinks(linksRes.data || []);
      if (usersRes.success) setUsers(usersRes.data || []);
    } catch (e) {
      console.error('Failed to load shares:', e);
    } finally {
      setLoading(false);
    }
  };

  const userName = (id) => {
    const u = users.find(u => u.id === id);
    return u ? u.username : id;
  };

  const handleDeleteShare = async (id) => {
    try {
      const res = await deleteShareById(id);
      if (res.success) {
        message.success('已删除');
        setShares(prev => prev.filter(s => s.id !== id));
      }
    } catch { message.error('删除失败'); }
  };

  const handleDeleteLink = async (id) => {
    try {
      const res = await deletePublicLink(id);
      if (res.success) {
        message.success('已删除');
        setLinks(prev => prev.filter(l => l.id !== id));
      }
    } catch { message.error('删除失败'); }
  };

  const handleToggleLink = async (id, enabled) => {
    try {
      const res = await togglePublicLink(id, enabled);
      if (res.success) {
        setLinks(prev => prev.map(l => l.id === id ? { ...l, enabled: enabled ? 1 : 0 } : l));
      }
    } catch { message.error('操作失败'); }
  };

  const shareColumns = [
    { title: '发起用户', dataIndex: 'fromUserId', key: 'from', render: (id) => userName(id) },
    { title: '目标用户', dataIndex: 'toUserId', key: 'to', render: (id) => userName(id) },
    { title: '共享类型', dataIndex: 'shareType', key: 'type', render: (t) => {
      const map = { logs: '日志', dictionaries: '词典', both: '日志+词典', history: '历史' };
      return <Tag color="blue">{map[t] || t}</Tag>;
    }},
    { title: '状态', dataIndex: 'status', key: 'status', render: (s) => (
      <Tag color={s === 'active' ? 'green' : 'orange'}>{s === 'active' ? '生效中' : '待确认'}</Tag>
    )},
    { title: '自动同步', dataIndex: 'autoSync', key: 'autoSync', render: (v) => v ? <Tag color="cyan">是</Tag> : <Tag>否</Tag> },
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', render: (t) => t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-' },
    {
      title: '操作', key: 'action', render: (_, r) => (
        <Popconfirm title="确定删除该共享关系？" onConfirm={() => handleDeleteShare(r.id)} okText="删除" cancelText="取消">
          <Button size="small" danger>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  const linkColumns = [
    { title: '分享码', dataIndex: 'share_code', key: 'code', render: (code) => <code>{code}</code> },
    { title: '用户', dataIndex: 'user_id', key: 'user', render: (id) => userName(id) },
    { title: 'Session', dataIndex: 'session_id', key: 'session', ellipsis: true },
    { title: '启用', dataIndex: 'enabled', key: 'enabled', render: (v, r) => (
      <Switch size="small" checked={!!v && !r.revoked_at} onChange={(checked) => handleToggleLink(r.id, checked)} />
    )},
    { title: '已撤销', dataIndex: 'revoked_at', key: 'revoked', render: (v) => v ? <Tag color="red">是</Tag> : <Tag color="green">否</Tag> },
    { title: '过期时间', dataIndex: 'expires_at', key: 'expires', render: (t) => t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '永不过期' },
    { title: '创建时间', dataIndex: 'created_at', key: 'created', render: (t) => t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-' },
    {
      title: '操作', key: 'action', render: (_, r) => (
        <Space>
          <Button size="small" onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/live/${r.share_code}`); message.success('链接已复制'); }}>
            复制链接
          </Button>
          <Popconfirm title="确定删除该链接？" onConfirm={() => handleDeleteLink(r.id)} okText="删除" cancelText="取消">
            <Button size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>分享管理</h1>
      <Card>
        <Tabs defaultActiveKey="public-links">
          <TabPane tab={`公开链接 (${links.length})`} key="public-links">
            <Table columns={linkColumns} dataSource={links} loading={loading} rowKey="id" size="small" />
          </TabPane>
          <TabPane tab={`用户间共享 (${shares.length})`} key="user-shares">
            <Table columns={shareColumns} dataSource={shares} loading={loading} rowKey="id" size="small" />
          </TabPane>
        </Tabs>
      </Card>
    </div>
  );
}

export default Shares;
