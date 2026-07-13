import { DeleteOutlined, LockOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Popconfirm, Space, Table, Tag, message } from 'antd';
import { useState } from 'react';
import { useAuth } from '../../AuthContext';
import { ApiError, accountApi, type DeviceSession } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import { useNavigate } from 'react-router-dom';

export default function AccountPage() {
  const { user, refreshUser, logout } = useAuth();
  const navigate = useNavigate();
  const { t, locale } = useI18n();
  const [messageApi, contextHolder] = message.useMessage();
  const [profileForm] = Form.useForm<{ username: string; currentPassword: string }>();
  const [profileSaving, setProfileSaving] = useState(false);
  const devices = useAsync(accountApi.devices, []);
  const saveProfile = async ({ username, currentPassword }: { username: string; currentPassword: string }) => {
    setProfileSaving(true);
    try {
      await accountApi.updateProfile(username.trim(), currentPassword);
      await refreshUser();
      profileForm.setFieldValue('currentPassword', '');
      messageApi.success(t('settings.applied'));
    } catch (reason) {
      messageApi.error(reason instanceof ApiError ? `${reason.message} (${reason.code})` : t('error.default'));
    } finally { setProfileSaving(false); }
  };
  const changePassword = async ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) => {
    await accountApi.changePassword(currentPassword, newPassword);
    messageApi.success(t('settings.applied'));
    await logout();
    navigate('/login', { replace: true });
  };
  return (
    <>
      {contextHolder}
      <PageHeader title={t('account.title')} />
      {user?.mustChangePassword && <Alert type="warning" showIcon message={t('account.security')} description={t('account.newPassword')} style={{ marginBottom: 16 }} />}
      <div className="content-grid">
        <Card className="surface" title={t('account.profile')}>
          <Form form={profileForm} layout="vertical" initialValues={{ username: user?.username }} onFinish={saveProfile}>
            <Form.Item label={t('auth.username')} name="username" rules={[{ required: true }, { min: 3 }, { max: 64 }]}><Input /></Form.Item>
            <Form.Item label={t('account.currentPassword')} name="currentPassword" rules={[{ required: true }]}><Input.Password prefix={<LockOutlined />} autoComplete="current-password" /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={profileSaving}>{t('common.save')}</Button>
          </Form>
        </Card>
        <Card className="surface" title={t('account.security')}>
          <Form layout="vertical" onFinish={changePassword}>
            <Form.Item label={t('account.currentPassword')} name="currentPassword" rules={[{ required: true }]}><Input.Password prefix={<LockOutlined />} /></Form.Item>
            <Form.Item label={t('account.newPassword')} name="newPassword" rules={[{ required: true }, { min: 10 }, { max: 128 }]}><Input.Password prefix={<LockOutlined />} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />}>{t('common.save')}</Button>
          </Form>
        </Card>
      </div>
      <Card className="surface table-card" title={t('account.devices')} extra={<Button type="text" icon={<ReloadOutlined />} onClick={devices.reload}>{t('common.refresh')}</Button>} style={{ marginTop: 16 }}>
        <AsyncContent loading={devices.loading} error={devices.error} empty={!devices.loading && !devices.data?.items.length} onRetry={devices.reload}>
          <Table<DeviceSession> rowKey="id" dataSource={devices.data?.items ?? []} scroll={{ x: 760 }} columns={[
            { title: t('account.device'), dataIndex: 'deviceId', render: (value: string | null, row) => <Space>{value ?? '—'}{row.current && <Tag color="blue">{t('account.current')}</Tag>}</Space> },
            { title: 'User-Agent', dataIndex: 'userAgent', ellipsis: true },
            { title: t('account.lastUsed'), dataIndex: 'lastUsedAt', render: (value: string | null) => value ? new Date(value).toLocaleString(locale) : '—' },
            { title: t('account.expires'), dataIndex: 'expiresAt', render: (value: string) => new Date(value).toLocaleString(locale) },
            { title: t('common.actions'), render: (_, row) => row.current ? null : <Popconfirm title={t('common.revoke')} onConfirm={async () => { await accountApi.revokeDevice(row.id); devices.reload(); }}><Button danger type="text" icon={<DeleteOutlined />}>{t('common.revoke')}</Button></Popconfirm> },
          ]} pagination={false} />
        </AsyncContent>
      </Card>
    </>
  );
}
