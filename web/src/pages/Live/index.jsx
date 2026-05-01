import { useEffect, useState } from 'react';
import { Table, Typography, Card, Space, Tag } from 'antd';
import { useParams } from 'react-router-dom';
import axios from 'axios';

const { Title, Text } = Typography;

export default function Live() {
  const { shareCode } = useParams();
  const [data, setData] = useState(null);
  const [time, setTime] = useState(new Date().toLocaleTimeString());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    async function poll() {
      try {
        const res = await axios.get(`/api/public/live/${shareCode}`);
        if (res.data.ok) setData(res.data);
      } catch (_) {}
    }
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, [shareCode]);

  if (!data) return <div style={{ padding: 40, textAlign: 'center' }}>加载中...</div>;

  const columns = [
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
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title level={3} style={{ margin: 0 }}>
            {data.session?.title || 'Live Share'}
          </Title>
          <Space>
            <Tag color="blue">只读</Tag>
            <Text>当前时间: {time}</Text>
            <Text>主控: {data.controller?.callsign || '暂无'}</Text>
          </Space>
        </div>
        <Card>
          <Table
            dataSource={data.logs || []}
            columns={columns}
            rowKey={r => r.sync_id || r.time}
            size="small"
            pagination={false}
          />
        </Card>
      </Space>
    </div>
  );
}
