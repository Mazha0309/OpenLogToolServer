import { useEffect, useState } from 'react';
import { Card, Switch, Table, message, Typography } from 'antd';
import api from '../api';

interface User { id: string; username: string; role: string; created_at: string; }

export default function Admin() {
  const [regEnabled, setRegEnabled] = useState(true);
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    api.get('/admin/settings').then(r => setRegEnabled(!!r.data.registration_enabled));
    api.get('/admin/users').then(r => setUsers(r.data));
  }, []);

  const toggleReg = async (v: boolean) => {
    await api.put('/admin/settings', { registration_enabled: v });
    setRegEnabled(v);
    message.success(v ? '已开启注册' : '已关闭注册');
  };

  return (
    <>
      <Card title={<Typography.Title level={4}>服务器设置</Typography.Title>}>
        <div style={{ marginBottom: 16 }}>
          <span>允许注册：</span>
          <Switch checked={regEnabled} onChange={toggleReg} />
        </div>
      </Card>
      <Card title={<Typography.Title level={4}>用户管理</Typography.Title>} style={{ marginTop: 16 }}>
        <Table dataSource={users} rowKey="id" columns={[
          { title: '用户名', dataIndex: 'username' },
          { title: '角色', dataIndex: 'role' },
          { title: '创建时间', dataIndex: 'created_at' },
        ]} />
      </Card>
    </>
  );
}
