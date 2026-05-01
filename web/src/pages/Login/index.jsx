import { useState } from 'react';
import { Form, Input, Button, Card, message } from 'antd';
import { login as loginApi, changePassword } from '../../services/auth';
import './index.css';

function Login({ onForceChangeComplete }) {
  const [loading, setLoading] = useState(false);
  const [showForceChange, setShowForceChange] = useState(false);
  const [changeLoading, setChangeLoading] = useState(false);
  const [loginSuccess, setLoginSuccess] = useState(false);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const result = await loginApi(values.username, values.password);
      if (result.success) {
        localStorage.setItem('token', result.data.token);
        localStorage.setItem('refreshToken', result.data.refreshToken);

        if (values.username === 'admin' && values.password === 'admin123') {
          const userWithFlag = { ...result.data.user, forceChange: true };
          localStorage.setItem('user', JSON.stringify(userWithFlag));
          setShowForceChange(true);
          setLoginSuccess(true);
        } else {
          localStorage.setItem('user', JSON.stringify(result.data.user));
          window.location.reload();
        }
      } else {
        message.error(result.error?.message || '用户名或密码错误');
      }
    } catch (error) {
      const errorMsg = error?.error?.message || error?.message || '用户名或密码错误';
      message.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleChangeAccount = async (values) => {
    if (values.newPassword !== values.confirmPassword) {
      message.error('两次密码不一致');
      return;
    }
    setChangeLoading(true);
    try {
      const newUsername = values.username?.trim();

      if (newUsername && newUsername !== 'admin') {
        const token = localStorage.getItem('token');
        const usernameRes = await fetch('/api/v1/auth/username', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ username: newUsername }),
        });
        if (!usernameRes.ok) {
          message.error('修改用户名失败');
          setChangeLoading(false);
          return;
        }
      }

      const passwordResult = await changePassword('admin123', values.newPassword);
      if (passwordResult.success) {
        const userStr = localStorage.getItem('user');
        const user = userStr ? JSON.parse(userStr) : {};
        delete user.forceChange;
        if (newUsername && newUsername !== 'admin') {
          user.username = newUsername;
        }
        localStorage.setItem('user', JSON.stringify(user));
        message.success('账号已修改');
        onForceChangeComplete?.();
        window.location.reload();
      } else {
        message.error(passwordResult.error?.message || '修改失败');
      }
    } catch (error) {
      message.error('修改失败');
    } finally {
      setChangeLoading(false);
    }
  };

  return (
    <div className="login-container">
      <Card title="OpenLogTool 管理后台" style={{ width: 400 }}>
        {!showForceChange ? (
          <Form layout="vertical" onFinish={onFinish}>
            <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input placeholder="admin" />
            </Form.Item>
            <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password placeholder="admin123" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block>
                登录
              </Button>
            </Form.Item>
          </Form>
        ) : (
          <div>
            <p style={{ color: '#ff4d4f', marginBottom: 16 }}>
              请修改默认管理员账号密码
            </p>
            <Form layout="vertical" onFinish={handleChangeAccount}>
              <Form.Item label="新用户名" name="username">
                <Input.Password placeholder="请输入新用户名（可选）" />
              </Form.Item>
              <Form.Item label="新密码" name="newPassword" rules={[{ required: true, message: '请输入新密码' }]}>
                <Input.Password placeholder="请输入新密码" />
              </Form.Item>
              <Form.Item label="确认密码" name="confirmPassword" rules={[{ required: true, message: '请确认密码' }]}>
                <Input.Password placeholder="请确认密码" />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit" loading={changeLoading} block>
                  确认修改
                </Button>
              </Form.Item>
            </Form>
          </div>
        )}
      </Card>
    </div>
  );
}

export default Login;
