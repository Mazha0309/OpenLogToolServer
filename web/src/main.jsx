import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './index.css';

const initialDark = localStorage.getItem('theme') === 'dark';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: initialDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        }}
      >
        <App initialDark={initialDark} />
      </ConfigProvider>
    </BrowserRouter>
  </React.StrictMode>
);
