import { useEffect, useState } from 'react';
import { Table, Tag, Button, Space, message, Modal, Form, Input, Popconfirm } from 'antd';
import { EyeOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { getSessions, deleteSession } from '../../services/session';
import dayjs from 'dayjs';

export default function Sessions() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => { loadSessions(); }, []);

  async function handleDelete(sessionId) {
    try {
      await deleteSession(sessionId);
      message.success('已删除');
      loadSessions();
    } catch (_) {
      message.error('删除失败');
    }
  }

  async function loadSessions() {
    setLoading(true);
    try {
      const res = await getSessions();
      if (res.ok && Array.isArray(res.data)) {
        setData(res.data);
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
    {
      title: '名称', dataIndex: 'title', key: 'title', width: 280,
      render: (t, r) => <a onClick={() => navigate(`/sessions/${r.session_id}`)}>{t}</a>,
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (s) => <Tag color={statusMap[s]?.color}>{statusMap[s]?.text || s}</Tag>,
    },
    { title: '日志数', dataIndex: 'log_count', key: 'log_count', width: 80 },
    {
      title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 180,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: '关闭时间', dataIndex: 'closed_at', key: 'closed_at', width: 180,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: '操作', key: 'action', width: 120,
      render: (_, r) => (
        <Space>
          <Button type="link" size="small" icon={<EyeOutlined />}
            onClick={() => navigate(`/sessions/${r.session_id}`)}>
            查看
          </Button>
          <Popconfirm title="确定删除此记录？" onConfirm={() => handleDelete(r.session_id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>记录历史</h1>
      </div>
      <Table
        dataSource={data}
        columns={columns}
        rowKey="session_id"
        loading={loading}
        pagination={{ pageSize: 20 }}
      />
    </div>
  );
}
