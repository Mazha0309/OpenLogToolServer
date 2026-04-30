import { useState, useEffect } from 'react';
import { Table, Tag, Typography, Card, Space } from 'antd';
import { HistoryOutlined } from '@ant-design/icons';
import { getSessions } from '../../services/session';

const { Title } = Typography;

export default function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { loadSessions(); }, []);

  async function loadSessions() {
    setLoading(true);
    try {
      const res = await getSessions();
      if (res.ok && Array.isArray(res.data)) {
        setSessions(res.data);
      }
    } catch (_) {}
    setLoading(false);
  }

  const statusMap = {
    active: { color: 'green', text: '进行中' },
    closed: { color: 'default', text: '已关闭' },
    archived: { color: 'orange', text: '已归档' },
  };

  const columns = [
    { title: 'Session ID', dataIndex: 'session_id', key: 'session_id', width: 240, ellipsis: true },
    { title: '名称', dataIndex: 'title', key: 'title' },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (status) => {
        const s = statusMap[status] || { color: 'default', text: status };
        return <Tag color={s.color}>{s.text}</Tag>;
      },
    },
    {
      title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 180,
      render: (v) => v ? new Date(v).toLocaleString() : '-',
    },
    {
      title: '关闭时间', dataIndex: 'closed_at', key: 'closed_at', width: 180,
      render: (v) => v ? new Date(v).toLocaleString() : '-',
    },
    { title: '来源设备', dataIndex: 'source_device_id', key: 'source_device_id', width: 240, ellipsis: true },
  ];

  return (
    <Card style={{ marginTop: 16 }}>
      <Space style={{ marginBottom: 16 }}>
        <HistoryOutlined style={{ fontSize: 20 }} />
        <Title level={4} style={{ margin: 0 }}>记录历史（Sessions）</Title>
      </Space>
      <Table
        dataSource={sessions}
        columns={columns}
        rowKey="session_id"
        loading={loading}
        pagination={{ pageSize: 20 }}
      />
    </Card>
  );
}
