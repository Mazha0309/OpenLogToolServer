import { useEffect, useState } from 'react';
import { Card, Switch, Button, message, Descriptions, Tag, Space, List, Modal, Divider } from 'antd';
import { getServerInfo } from '../../services/admin';
import dayjs from 'dayjs';

function Settings({ darkMode, onDarkModeChange }) {
  const [serverInfo, setServerInfo] = useState(null);
  const [debugLogs, setDebugLogs] = useState([]);
  const [logModalVisible, setLogModalVisible] = useState(false);

  useEffect(() => {
    loadServerInfo();
  }, []);

  const loadServerInfo = async () => {
    try {
      const result = await getServerInfo();
      if (result.success) {
        setServerInfo(result.data);
        addLog('服务器信息加载成功');
      }
    } catch (error) {
      addLog('加载服务器信息失败: ' + (error?.message || '未知错误'));
    }
  };

  const addLog = (msg) => {
    const timestamp = dayjs().format('HH:mm:ss');
    setDebugLogs(prev => [{
      time: timestamp,
      message: msg,
      type: msg.includes('失败') || msg.includes('错误') ? 'error' : 'info'
    }, ...prev.slice(0, 49)]);
  };

  const handleThemeChange = (checked) => {
    onDarkModeChange?.(checked);
    localStorage.setItem('theme', checked ? 'dark' : 'light');
    message.success(`已切换到${checked ? '深色' : '浅色'}模式`);
    addLog(`主题切换到${checked ? '深色' : '浅色'}模式`);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    window.location.reload();
  };

  const formatUptime = (seconds) => {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts = [];
    if (d > 0) parts.push(`${d}天`);
    if (h > 0) parts.push(`${h}小时`);
    if (m > 0) parts.push(`${m}分钟`);
    parts.push(`${s}秒`);
    return parts.join('');
  };

  const getDbColor = (dbType) => {
    switch (dbType) {
      case 'memory': return 'orange';
      case 'mysql': return 'blue';
      case 'mongodb': return 'green';
      default: return 'default';
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>系统设置</h1>

      <Card title="外观设置" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>深色模式</span>
          <Switch checked={darkMode} onChange={handleThemeChange} />
        </div>
      </Card>

      <Card title="服务器信息" style={{ marginBottom: 16 }}>
        {serverInfo ? (
          <Descriptions column={2} bordered size="small">
            <Descriptions.Item label="数据库类型">
              <Tag color={getDbColor(serverInfo.dbType)}>{serverInfo.adapterType}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Node.js 版本">
              <Tag>{serverInfo.nodeVersion}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="服务器版本">
              <Tag>{serverInfo.version}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="运行时间">
              <Tag>{formatUptime(serverInfo.uptime)}</Tag>
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Space>
            <Button onClick={loadServerInfo}>加载服务器信息</Button>
          </Space>
        )}
      </Card>

      <Card
        title="调试日志"
        extra={
          <Space>
            <Button size="small" onClick={() => { setDebugLogs([]); addLog('日志已清空'); }}>
              清空
            </Button>
            <Button size="small" onClick={() => setLogModalVisible(true)}>
              查看全部
            </Button>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <List
          size="small"
          dataSource={debugLogs.slice(0, 5)}
          renderItem={(item) => (
            <List.Item style={{ padding: '4px 0' }}>
              <Space>
                <Tag color={item.type === 'error' ? 'red' : 'blue'}>{item.time}</Tag>
                <span style={{ color: item.type === 'error' ? '#ff4d4f' : 'inherit' }}>
                  {item.message}
                </span>
              </Space>
            </List.Item>
          )}
          locale={{ emptyText: '暂无日志' }}
        />
      </Card>

      <Card title="账号安全">
        <Button onClick={handleLogout} danger>
          退出登录
        </Button>
      </Card>

      <Modal
        title="调试日志"
        open={logModalVisible}
        onCancel={() => setLogModalVisible(false)}
        footer={[
          <Button key="close" onClick={() => setLogModalVisible(false)}>
            关闭
          </Button>,
          <Button key="clear" onClick={() => { setDebugLogs([]); addLog('日志已清空'); }}>
            清空
          </Button>,
        ]}
        width={700}
      >
        <List
          size="small"
          dataSource={debugLogs}
          renderItem={(item) => (
            <List.Item style={{ padding: '4px 0' }}>
              <Space>
                <Tag color={item.type === 'error' ? 'red' : 'blue'}>{item.time}</Tag>
                <span style={{ color: item.type === 'error' ? '#ff4d4f' : 'inherit' }}>
                  {item.message}
                </span>
              </Space>
            </List.Item>
          )}
          locale={{ emptyText: '暂无日志' }}
          style={{ maxHeight: 400, overflow: 'auto' }}
        />
      </Modal>
    </div>
  );
}

export default Settings;