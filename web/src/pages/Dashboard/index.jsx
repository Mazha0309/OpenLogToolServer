import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Table, Tag, Typography } from 'antd';
import { FileTextOutlined, MobileOutlined, SyncOutlined, HistoryOutlined } from '@ant-design/icons';
import { getStats, getSyncLogs } from '../../services/admin';
import { getSessions } from '../../services/session';
import dayjs from 'dayjs';

function Dashboard() {
  const [stats, setStats] = useState({
    totalLogs: 0,
    totalDevices: 0,
    todayLogs: 0,
    weekLogs: 0,
  });
  const [syncLogs, setSyncLogs] = useState([]);
  const [sessionCount, setSessionCount] = useState(0);

  useEffect(() => {
    loadStats();
    loadSyncLogs();
    loadSessionCount();
  }, []);

  const loadSessionCount = async () => {
    try {
      const result = await getSessions();
      if (result.ok && Array.isArray(result.data)) {
        setSessionCount(result.data.length);
      }
    } catch (_) {}
  };

  const loadStats = async () => {
    try {
      const result = await getStats();
      if (result.success) {
        setStats(result.data);
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  };

  const loadSyncLogs = async () => {
    try {
      const result = await getSyncLogs(10);
      if (result.success) {
        setSyncLogs(result.data);
      }
    } catch (error) {
      console.error('Failed to load sync logs:', error);
    }
  };

  const renderSyncDetails = (details) => {
    if (!details) return '-';
    const upload = details.upload || {};
    const download = details.download || {};
    return (
      <div style={{ fontSize: 12, lineHeight: 1.5 }}>
        <div><strong>基线:</strong> {details.since || '-'}</div>
        <div><strong>上传:</strong> {upload.total ?? 0}（会话 {upload.sessions ?? 0} / 日志 {upload.logs ?? 0} / 词典 {upload.dictionaries ?? 0} / QTH {upload.callsignQthHistory ?? 0}）</div>
        <div><strong>下载:</strong> {download.total ?? 0}（会话 {download.sessions ?? 0} / 日志 {download.logs ?? 0} / 词典 {download.dictionaries ?? 0} / QTH {download.callsignQthHistory ?? 0}）</div>
      </div>
    );
  };

  const syncColumns = [
    { title: '设备ID', dataIndex: 'deviceId', key: 'deviceId' },
    { title: '同步类型', dataIndex: 'syncType', key: 'syncType', render: (type) => (
      <Tag color={type === 'push' ? 'blue' : type === 'pull' ? 'green' : 'orange'}>
        {type === 'push' ? '上传' : type === 'pull' ? '拉取' : '双向'}
      </Tag>
    )},
    { title: '记录数', dataIndex: 'recordsCount', key: 'recordsCount' },
    { title: '详情', dataIndex: 'details', key: 'details', render: renderSyncDetails },
    { title: '同步时间', dataIndex: 'syncedAt', key: 'syncedAt', render: (time) => time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : '-' },
  ];

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>仪表板</h1>
      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic title="总日志数" value={stats.totalLogs} prefix={<FileTextOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="今日新增" value={stats.todayLogs} prefix={<FileTextOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="本周新增" value={stats.weekLogs} prefix={<SyncOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="记录历史" value={sessionCount} prefix={<HistoryOutlined />} />
          </Card>
        </Col>
      </Row>
      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic title="注册设备" value={stats.totalDevices} prefix={<MobileOutlined />} />
          </Card>
        </Col>
      </Row>
      <Card title="最近同步记录" style={{ marginTop: 24 }}>
        <Table columns={syncColumns} dataSource={syncLogs} rowKey="id" pagination={false} />
      </Card>
    </div>
  );
}

export default Dashboard;
