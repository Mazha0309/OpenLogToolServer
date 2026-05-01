import { useEffect, useState } from 'react';
import { Table, Result, Button, Space, Typography, ConfigProvider, theme } from 'antd';
import { ClockCircleOutlined, UserOutlined } from '@ant-design/icons';
import { useParams } from 'react-router-dom';
import axios from 'axios';

const { Title, Text } = Typography;

function LivePage({ data, time, onToggleDark, dark }) {
  const { token } = theme.useToken();
  const bg = { padding: 24, minHeight: '100vh', backgroundColor: token.colorBgContainer, color: token.colorText };

  const columns = [
    { title: '#', key: 'i', width: 40, render: (_, __, i) => (data?.logs?.length || 0) - i },
    { title: '时间', dataIndex: 'time', width: 60 },
    { title: '主控', dataIndex: 'controller', width: 80 },
    { title: '呼号', dataIndex: 'callsign', width: 80 },
    { title: '报告', dataIndex: 'report', width: 50 },
    { title: 'QTH', dataIndex: 'qth', width: 100 },
    { title: '设备', dataIndex: 'device', width: 80 },
    { title: '功率', dataIndex: 'power', width: 60 },
    { title: '天线', dataIndex: 'antenna', width: 80 },
    { title: '高度', dataIndex: 'height', width: 60 },
  ];

  return (
    <div style={bg}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>{data.session?.title || 'Live Share'}</Title>
        <Space size="middle">
          <Button size="small" onClick={onToggleDark}>{dark ? '亮色模式' : '暗色模式'}</Button>
          <Text type="secondary"><ClockCircleOutlined /> {time}</Text>
          <Text type="secondary"><UserOutlined /> 主控: {data.controller?.callsign || '暂无'}</Text>
        </Space>
      </div>
      <Table dataSource={data.logs || []} columns={columns}
        rowKey={r => r.sync_id || r.time} pagination={false} size="small" />
    </div>
  );
}

export default function Live() {
  const { shareCode } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [time, setTime] = useState(new Date().toLocaleTimeString());
  const [dark, setDark] = useState(() => localStorage.getItem('live_dark') === '1');

  useEffect(() => {
    document.title = 'Live Share - OpenLogTool';
  }, []);

  useEffect(() => {
    document.title = 'Live Share - OpenLogTool';
  }, []);

  useEffect(() => {
    document.title = 'Live Share - OpenLogTool';
  }, []);

  useEffect(() => {
    const t = data?.session?.title;
    if (t) document.title = `${t} - OpenLogTool`;
  }, [data?.session?.title]);

  useEffect(() => {
    document.title = 'OpenLogTool - Live Share';
  }, []);

  useEffect(() => {
    if (data?.session?.title) document.title = `OpenLogTool - ${data.session.title}`;
  }, [data]);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    async function poll() {
      try {
        const res = await axios.get(`/api/public/live/${shareCode}`);
        if (res.data.ok) { setData(res.data); setError(null); }
        else { setError(res.data.error || '链接无效'); }
      } catch (e) {
        if (e.response?.status === 410) setError('链接已过期');
        else if (e.response?.status === 404) setError('链接不存在');
        else setError('加载失败');
      }
    }
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, [shareCode]);

  function toggleDark() {
    const v = !dark;
    setDark(v);
    localStorage.setItem('live_dark', v ? '1' : '0');
  }

  return (
    <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
      {error ? (
        <div style={bg}>
          <Result status="error" title={error} subTitle="请联系分享者获取新链接"
            extra={<Button type="primary" onClick={() => window.location.reload()}>重试</Button>} />
        </div>
      ) : !data ? (
        <div style={bg}>
          <Text type="secondary">加载中...</Text>
        </div>
      ) : (
        <LivePage data={data} time={time} onToggleDark={toggleDark} dark={dark} />
      )}
    </ConfigProvider>
  );
}