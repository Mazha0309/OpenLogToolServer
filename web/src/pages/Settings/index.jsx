import { Card, Switch, Button, message } from 'antd';

function Settings({ darkMode, onDarkModeChange }) {
  const handleThemeChange = (checked) => {
    onDarkModeChange?.(checked);
    localStorage.setItem('theme', checked ? 'dark' : 'light');
    message.success(`已切换到${checked ? '深色' : '浅色'}模式`);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    window.location.reload();
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

      <Card title="数据同步" style={{ marginBottom: 16 }}>
        <p>服务器已连接</p>
      </Card>

      <Card title="账号安全">
        <Button onClick={handleLogout} danger>
          退出登录
        </Button>
      </Card>
    </div>
  );
}

export default Settings;