import { useEffect, useState } from 'react';
import { Table, Card, Typography } from 'antd';
import api from '../api';

interface Session { id: string; title: string; status: string; created_at: string; }

export default function Dashboard() {
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => { api.get('/sessions').then(r => setSessions(r.data)); }, []);

  return (
    <Card title={<Typography.Title level={4}>Session 列表</Typography.Title>}>
      <Table dataSource={sessions} rowKey="id" columns={[
        { title: '标题', dataIndex: 'title' },
        { title: '状态', dataIndex: 'status' },
        { title: '创建时间', dataIndex: 'created_at' },
      ]} />
    </Card>
  );
}
