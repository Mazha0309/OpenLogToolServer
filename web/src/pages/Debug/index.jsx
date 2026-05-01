import { useEffect, useState } from 'react';
import { Table, Card, Row, Col, Statistic, Button, Typography, Tabs, Tag, Space, Select, Descriptions } from 'antd';
import { ReloadOutlined, DatabaseOutlined, ApiOutlined, BugOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title, Text } = Typography;
const { TabPane } = Tabs;

const token = localStorage.getItem('token');

const headers = token ? { Authorization: `Bearer ${token}` } : {};

export default function Debug() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { loadState(); }, []);

  async function loadState() {
    setLoading(true);
    try {
      const res = await axios.get('/api/v1/debug/state', { headers });
      if (res.data.ok) setState(res.data);
    } catch (_) {}
    setLoading(false);
  }

  const logColumns = [
    { title: '#', key: 'i', width: 40, render: (_, __, i) => (state?.logs?.length || 0) - i },
    { title: 'sync_id', dataIndex: 'syncId', key: 'syncId', width: 200, ellipsis: true },
    { title: 'session_id', dataIndex: 'sessionId', key: 'sessionId', width: 200, ellipsis: true,
      render: v => v ? <Text code>{v?.substring(0, 16)}...</Text> : <Tag color="red">NULL</Tag> },
    { title: '时间', dataIndex: 'time', key: 'time', width: 60 },
    { title: 'controller', dataIndex: 'controller', key: 'controller', width: 80 },
    { title: 'callsign', dataIndex: 'callsign', key: 'callsign', width: 80 },
    { title: 'deleted', dataIndex: 'deletedAt', key: 'deletedAt', width: 60,
      render: v => v ? <Tag color="red">YES</Tag> : <Tag>no</Tag> },
    { title: 'user_id', dataIndex: 'userId', key: 'userId', width: 200, ellipsis: true },
  ];

  const sessionColumns = [
    { title: '#', key: 'i', width: 40, render: (_, __, i) => i + 1 },
    { title: 'session_id', dataIndex: 'session_id', key: 'session_id', width: 200, ellipsis: true },
    { title: 'title', dataIndex: 'title', key: 'title' },
    { title: 'status', dataIndex: 'status', key: 'status', width: 80,
      render: s => <Tag color={s === 'active' ? 'green' : 'default'}>{s}</Tag> },
    { title: 'deleted', dataIndex: 'deleted_at', key: 'deleted_at', width: 60,
      render: v => v ? <Tag color="red">YES</Tag> : <Tag>no</Tag> },
    { title: 'user_id', dataIndex: 'user_id', key: 'user_id', width: 200, ellipsis: true },
  ];

  const linkColumns = [
    { title: 'share_code', dataIndex: 'share_code', key: 'share_code' },
    { title: 'session_id', dataIndex: 'session_id', key: 'session_id', width: 200, ellipsis: true },
    { title: 'enabled', dataIndex: 'enabled', key: 'enabled', width: 60,
      render: v => v ? <Tag color="green">yes</Tag> : <Tag>no</Tag> },
    { title: 'expires_at', dataIndex: 'expires_at', key: 'expires_at', width: 180,
      render: v => v ? new Date(v).toLocaleString() : '-' },
    { title: 'revoked', dataIndex: 'revoked_at', key: 'revoked_at', width: 60,
      render: v => v ? <Tag color="red">yes</Tag> : <Tag>no</Tag> },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Space style={{ marginBottom: 16 }}>
        <BugOutlined style={{ fontSize: 20 }} />
        <Title level={4} style={{ margin: 0 }}>Debug Panel</Title>
        <Button icon={<ReloadOutlined />} onClick={loadState} loading={loading}>刷新</Button>
      </Space>

      {state && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={4}><Card><Statistic title="Sessions" value={state.counts.sessions} /></Card></Col>
          <Col span={4}><Card><Statistic title="Logs" value={state.counts.logs} /></Card></Col>
          <Col span={4}><Card><Statistic title="Users" value={state.counts.users} /></Card></Col>
          <Col span={4}><Card><Statistic title="Links" value={state.counts.publicLinks} /></Card></Col>
          <Col span={4}><Card><Statistic title="Changes" value={state.counts.changeLog} /></Card></Col>
          <Col span={4}><Card><Statistic title="Next Δ ID" value={state.counts.nextChangeId} /></Card></Col>
        </Row>
      )}

      {state && (
        <Tabs defaultActiveKey="sessions">
          <Tabs.TabPane tab={`Sessions (${state.counts.sessions})`} key="sessions">
            <Table dataSource={state.sessions} columns={sessionColumns} rowKey="session_id" size="small" pagination={{ pageSize: 50 }} />
          </Tabs.TabPane>
          <Tabs.TabPane tab={`Logs (${state.counts.logs})`} key="logs">
            <Table dataSource={state.logs} columns={logColumns} rowKey="id" size="small" pagination={{ pageSize: 50 }} />
          </Tabs.TabPane>
          <Tabs.TabPane tab={`Public Links (${state.counts.publicLinks})`} key="links">
            <Table dataSource={state.publicLinks} columns={linkColumns} rowKey="id" size="small" pagination={{ pageSize: 50 }} />
          </Tabs.TabPane>
          <Tabs.TabPane tab={`Change Log (${state.counts.changeLog})`} key="changes">
            <pre style={{ fontSize: 12, maxHeight: 600, overflow: 'auto' }}>
              {JSON.stringify(state.changeLog, null, 2)}
            </pre>
          </Tabs.TabPane>
        </Tabs>
      )}
    </div>
  );
}
