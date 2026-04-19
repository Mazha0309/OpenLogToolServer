import { useEffect, useState } from 'react';
import { Table, Tag, Card, Space } from 'antd';
import { getDevices } from '../../services/admin';
import dayjs from 'dayjs';

function Devices() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadDevices();
  }, []);

  const loadDevices = async () => {
    setLoading(true);
    try {
      const result = await getDevices();
      if (result.success) {
        setData(result.data);
      }
    } catch (error) {
      console.error('Failed to load devices:', error);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    { title: '设备ID', dataIndex: 'deviceId', key: 'deviceId' },
    { title: '设备名称', dataIndex: 'name', key: 'name' },
    { title: '最后同步', dataIndex: 'lastSyncAt', key: 'lastSyncAt', render: (time) => time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : '-' },
    { title: '状态', dataIndex: 'lastSyncAt', key: 'status', render: (time) => (
      <Tag color={time ? 'green' : 'red'}>{time ? '在线' : '离线'}</Tag>
    )},
  ];

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>设备管理</h1>
      <Card extra={<Space><Tag color="blue">共 {data.length} 台设备</Tag></Space>}>
        <Table columns={columns} dataSource={data} loading={loading} rowKey="id" />
      </Card>
    </div>
  );
}

export default Devices;
