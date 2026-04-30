import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { Menu, Layout, ConfigProvider, theme } from 'antd';
import { useState, useEffect } from 'react';
import {
  DashboardOutlined,
  BookOutlined,
  MobileOutlined,
  SettingOutlined,
  UserOutlined,
  HistoryOutlined,
} from '@ant-design/icons';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Dictionaries from './pages/Dictionaries';
import Devices from './pages/Devices';
import Settings from './pages/Settings';
import SubAccounts from './pages/SubAccounts';
import Sessions from './pages/Sessions';
import SessionDetail from './pages/Sessions/Detail';
import zhCN from 'antd/locale/zh_CN';

const { Header, Content, Sider } = Layout;

function App({ initialDark = false }) {
  const location = useLocation();
  const [needsForceChange, setNeedsForceChange] = useState(false);
  const [darkMode, setDarkMode] = useState(initialDark);

  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      try {
        const user = JSON.parse(userStr);
        if (user.username === 'admin' && user.forceChange) {
          setNeedsForceChange(true);
        }
      } catch (_) {}
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
          colorBgContainer: darkMode ? '#1f1f1f' : '#ffffff',
          colorBgElevated: darkMode ? '#262626' : '#ffffff',
        },
        components: {
          Menu: {
            darkItemBg: '#141414',
            darkSubMenuItemBg: '#141414',
            darkItemSelectedBg: '#262626',
            darkItemHoverBg: '#303030',
            darkItemColor: '#ffffffb3',
            darkItemSelectedColor: '#ffffff',
          },
        },
      }}
    >
      <Layout style={{ minHeight: '100vh' }}>
        <Layout>
          <Header style={{ background: darkMode ? '#141414' : '#001529', padding: '0 16px', display: 'flex', alignItems: 'center' }}>
            <h1 style={{ color: '#fff', margin: 0, fontSize: 18 }}>OpenLogTool 管理后台</h1>
          </Header>
          <Layout style={{ padding: '0' }}>
            <Sider width={200} style={{ background: darkMode ? '#141414' : '#fff', borderRight: darkMode ? '1px solid #303030' : '1px solid #f0f0f0' }}>
              <Menu
                mode="inline"
                selectedKeys={[location.pathname.split('/')[1] || 'dashboard']}
                theme={darkMode ? 'dark' : 'light'}
                style={{ background: darkMode ? '#141414' : 'transparent', border: 'none' }}
              >
                <Menu.Item key="dashboard" icon={<DashboardOutlined />}>
                  <Link to="/dashboard">仪表板</Link>
                </Menu.Item>
                <Menu.Item key="sessions" icon={<HistoryOutlined />}>
                  <Link to="/sessions">记录历史</Link>
                </Menu.Item>
                <Menu.Item key="dictionaries" icon={<BookOutlined />}>
                  <Link to="/dictionaries">词典管理</Link>
                </Menu.Item>
                <Menu.Item key="devices" icon={<MobileOutlined />}>
                  <Link to="/devices">设备管理</Link>
                </Menu.Item>
                <Menu.Item key="subaccounts" icon={<UserOutlined />}>
                  <Link to="/subaccounts">子账号</Link>
                </Menu.Item>
                <Menu.Item key="settings" icon={<SettingOutlined />}>
                  <Link to="/settings">设置</Link>
                </Menu.Item>
              </Menu>
            </Sider>
            <Content style={{ padding: '0 24px' }}>
              <Routes>
                <Route path="/dashboard" element={<Dashboard darkMode={darkMode} onDarkModeChange={setDarkMode} />} />
                <Route path="/logs" element={<Navigate to="/sessions" />} />
                <Route path="/dictionaries" element={<Dictionaries />} />
                <Route path="/devices" element={<Devices />} />
                <Route path="/sessions" element={<Sessions />} />
                <Route path="/sessions/:sessionId" element={<SessionDetail />} />
                <Route path="/subaccounts" element={<SubAccounts />} />
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
