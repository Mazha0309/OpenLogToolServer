import { Routes, Route, Navigate, Link } from 'react-router-dom';
import { Menu, Layout, ConfigProvider, theme } from 'antd';
import { useState, useEffect } from 'react';
import {
  DashboardOutlined,
  FileTextOutlined,
  BookOutlined,
  MobileOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Logs from './pages/Logs';
import Dictionaries from './pages/Dictionaries';
import Devices from './pages/Devices';
import Settings from './pages/Settings';
import zhCN from 'antd/locale/zh_CN';

const { Header, Content, Sider } = Layout;

function App() {
  const [needsForceChange, setNeedsForceChange] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      try {
        const user = JSON.parse(userStr);
        if (user.username === 'admin' && user.forceChange) {
          setNeedsForceChange(true);
        }
        if (user.theme === 'dark') {
          setDarkMode(true);
        }
      } catch (_) {}
    }
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      setDarkMode(true);
    }
  }, []);

  const token = localStorage.getItem('token');

  if (!token || needsForceChange) {
    return <Login onForceChangeComplete={() => setNeedsForceChange(false)} />;
  }

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: darkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1890ff',
        },
      }}
    >
      <Layout style={{ minHeight: '100vh' }}>
        <Layout>
          <Header style={{ background: darkMode ? '#141414' : '#001529', padding: '0 16px', display: 'flex', alignItems: 'center' }}>
            <h1 style={{ color: '#fff', margin: 0, fontSize: 18 }}>OpenLogTool 管理后台</h1>
          </Header>
          <Layout style={{ padding: '0' }}>
            <Sider width={200} style={{ background: darkMode ? '#141414' : '#fff' }}>
              <Menu mode="inline" defaultSelectedKeys={['dashboard']} theme={darkMode ? 'dark' : 'light'}>
                <Menu.Item key="dashboard" icon={<DashboardOutlined />}>
                  <Link to="/dashboard">仪表板</Link>
                </Menu.Item>
                <Menu.Item key="logs" icon={<FileTextOutlined />}>
                  <Link to="/logs">日志管理</Link>
                </Menu.Item>
                <Menu.Item key="dictionaries" icon={<BookOutlined />}>
                  <Link to="/dictionaries">词典管理</Link>
                </Menu.Item>
                <Menu.Item key="devices" icon={<MobileOutlined />}>
                  <Link to="/devices">设备管理</Link>
                </Menu.Item>
                <Menu.Item key="settings" icon={<SettingOutlined />}>
                  <Link to="/settings">设置</Link>
                </Menu.Item>
              </Menu>
            </Sider>
            <Content style={{ padding: '0 24px' }}>
              <Routes>
                <Route path="/dashboard" element={<Dashboard darkMode={darkMode} onDarkModeChange={setDarkMode} />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="/dictionaries" element={<Dictionaries />} />
                <Route path="/devices" element={<Devices />} />
                <Route path="/settings" element={<Settings darkMode={darkMode} onDarkModeChange={setDarkMode} />} />
                <Route path="*" element={<Navigate to="/dashboard" />} />
              </Routes>
            </Content>
          </Layout>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}

export default App;
