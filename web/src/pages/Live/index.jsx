import { useEffect, useState } from 'react';
import { Table, Typography, Card, Row, Col, Statistic, Result, Button } from 'antd';
import { ClockCircleOutlined, UserOutlined } from '@ant-design/icons';
import { useParams } from 'react-router-dom';
import axios from 'axios';

const { Title } = Typography;

export default function Live() {
  const { shareCode } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [time, setTime] = useState(new Date().toLocaleTimeString());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    async function poll() {
      try {
        const res = await axios.get(`/api/public/live/${shareCode}`);
        if (res.data.ok) {
          setData(res.data);
          setError(null);
        } else {
          setError(res.data.error || '链接无效');
        }
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

  if (error) return (
    <Result
      status="error"
      title={error}
      subTitle="请联系分享者获取新链接"
      extra={<Button type="primary" onClick={() => window.location.reload()}>重试</Button>}
    />
  );

  if (!data) return <div style={{ padding: 40, textAlign: 'center', fontSize: 16 }}>加载中...</div>;

  const columns = [
    { title: '#', key: 'index', width: 50, render: (_, __, i) => (data.logs?.length || 0) - i },
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
    <div style={{ padding: 24, minHeight: '100vh' }}>
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={[16, 16]} align="middle">
          <Col flex="auto">
            <Title level={4} style={{ margin: 0 }}>{data.session?.title || 'Live Share'}</Title>
          </Col>
          <Col>
            <Statistic title="当前时间" value={time} prefix={<ClockCircleOutlined />} />
          </Col>
          <Col>
            <Statistic title="当前主控" value={data.controller?.callsign || '暂无'} prefix={<UserOutlined />} />
          </Col>
        </Row>
      </Card>
      <Card>
        <Table
          dataSource={(data.logs || []).slice().reverse()}
          columns={columns}
          rowKey={r => r.sync_id || r.time}
          size="small"
          pagination={false}
        />
      </Card>
    </div>
  );
}
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

  const { token } = theme.useToken();

  if (error) return (
    <Result
      status="error"
      title={error}
      subTitle="请联系分享者获取新链接"
      extra={<Button type="primary" onClick={() => window.location.reload()}>重试</Button>}
    />
  );

  if (!data) return <div style={{ padding: 40, textAlign: 'center' }}>加载中...</div>;

  const columns = [
    { title: '#', key: 'index', width: 50, render: (_, __, i) => (data.logs?.length || 0) - i },
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
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto', minHeight: '100vh',
      backgroundColor: darkMode ? '#141414' : '#f5f5f5', color: darkMode ? '#fff' : 'inherit' }}>
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={24} align="middle" justify="space-between">
          <Col>
            <Title level={4} style={{ margin: 0 }}>{data.session?.title || 'Live Share'}</Title>
          </Col>
          <Col>
            <Button size="small" onClick={() => setDarkMode(!darkMode)}>
              {darkMode ? '亮色模式' : '暗色模式'}
            </Button>
          </Col>
          <Col>
            <Statistic title="当前时间" value={time} prefix={<ClockCircleOutlined />} />
          </Col>
          <Col>
            <Statistic title="当前主控" value={data.controller?.callsign || '暂无'} prefix={<UserOutlined />} />
          </Col>
        </Row>
      </Card>
      <Card>
        <Table
          dataSource={(data.logs || []).slice().reverse()}
          columns={columns}
          rowKey={r => r.sync_id || r.time}
          size="small"
          pagination={false}
        />
      </Card>
    </div>
  );
}
