import { useState, useEffect } from 'react';
import { Table, Tag, Typography, Card, Space, Button, Modal } from 'antd';
import { HistoryOutlined, EyeOutlined } from '@ant-design/icons';
import { getSessions, getSessionLogs } from '../../services/session';

const { Title } = Typography;

export default function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalLogs, setModalLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);

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

  async function viewLogs(session) {
    setModalTitle(session.title || session.session_id);
    setModalVisible(true);
    setLogsLoading(true);
    try {
      const res = await getSessionLogs(session.session_id, { pageSize: 200 });
      if (res.ok && res.data) {
        setModalLogs(Array.isArray(res.data) ? res.data : res.data.data || []);
      }
    } catch (_) {}
    setLogsLoading(false);
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
    { title: '来源', dataIndex: 'source_device_id', key: 'source_device_id', width: 200, ellipsis: true },
    {
      title: '操作', key: 'action', width: 100,
      render: (_, record) => (
        <Button type="link" icon={<EyeOutlined />} onClick={() => viewLogs(record)}>
          查看日志
        </Button>
      ),
    },
  ];

  const logColumns = [
    { title: '时间', dataIndex: 'time', key: 'time', width: 80 },
    { title: '主控', dataIndex: 'controller', key: 'controller', width: 100 },
    { title: '呼号', dataIndex: 'callsign', key: 'callsign', width: 100 },
    { title: '报告', dataIndex: 'report', key: 'report', width: 60 },
    { title: 'QTH', dataIndex: 'qth', key: 'qth', width: 120 },
    { title: '设备', dataIndex: 'device', key: 'device', width: 100 },
    { title: '功率', dataIndex: 'power', key: 'power', width: 80 },
    { title: '天线', dataIndex: 'antenna', key: 'antenna', width: 100 },
    { title: '高度', dataIndex: 'height', key: 'height', width: 80 },
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

      <Modal
        title={modalTitle}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
        width={1000}
      >
        <Table
          dataSource={modalLogs}
          columns={logColumns}
          rowKey={(r) => r.id || r.sync_id || r.time}
          loading={logsLoading}
          size="small"
          pagination={{ pageSize: 20 }}
        />
      </Modal>
    </Card>
  );
}
