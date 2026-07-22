import { CopyOutlined, EyeOutlined, ReloadOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../AuthContext';
import { ApiError, adminApi, type PasswordResetResult } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import type { User } from '../../types';

type SensitiveAction = { title: string; run: (reason: string) => Promise<unknown>; resetPassword?: boolean };

function formatBytes(value: number, locale: string): string {
  if (value < 1024) return `${value} B`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1024)} KiB`;
}

function UserDetailDrawer({ userId, currentUserId, onClose, onChanged }: { userId: string; currentUserId?: string; onClose: () => void; onChanged: () => void }) {
  const { t, locale } = useI18n();
  // A changed resource starts a distinct audited detail visit.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const accessId = useMemo(() => crypto.randomUUID(), [userId]);
  const state = useAsync(() => adminApi.user(userId, accessId), [userId, accessId]);
  const [action, setAction] = useState<SensitiveAction | null>(null);
  const [form] = Form.useForm();
  const [temporary, setTemporary] = useState<PasswordResetResult | null>(null);
  const [working, setWorking] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const user = state.data?.user;
  const execute = async () => {
    if (!action) return;
    let values: { password: string; reason: string };
    try { values = await form.validateFields(); } catch { return; }
    setWorking(true);
    try {
      await adminApi.elevate(values.password);
      const result = await action.run(values.reason.trim());
      if (action.resetPassword) setTemporary(result as PasswordResetResult);
      setAction(null); form.resetFields(); state.reload(); onChanged();
      messageApi.success(t('settings.applied'));
    } catch (error) {
      messageApi.error(error instanceof ApiError ? `${error.message} (${error.code})` : t('error.default'));
    } finally { setWorking(false); }
  };
  return <>{contextHolder}<Drawer width={620} open title={t('admin.userDetails')} onClose={onClose} extra={<Button icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>}>
    <AsyncContent loading={state.loading} error={state.error} onRetry={state.reload}>
      {state.data && user && <>
        <Descriptions bordered size="small" column={1} items={[
          { key: 'username', label: t('auth.username'), children: user.username },
          { key: 'id', label: 'ID', children: user.id },
          { key: 'role', label: t('common.role'), children: <Tag color={user.role === 'admin' ? 'gold' : 'default'}>{t(`role.${user.role}`)}</Tag> },
          { key: 'status', label: t('common.status'), children: user.deletedAt ? <Tag color="red">{t('session.deleted')}</Tag> : user.disabledAt ? <Tag color="orange">{t('common.close')}</Tag> : <Tag color="green">{t('common.active')}</Tag> },
          { key: 'mustChange', label: t('auth.passwordChangeRequired'), children: user.mustChangePassword ? t('common.yes') : t('common.no') },
          { key: 'loginExpiration', label: t('admin.loginExpiration'), children: user.loginNeverExpires ? <Tag color="blue">{t('admin.neverExpires')}</Tag> : t('admin.standardExpiration') },
          { key: 'created', label: t('sessions.createdAt'), children: user.createdAt ? new Date(user.createdAt).toLocaleString(locale) : '—' },
        ]} />
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginTop: 16 }}>
          <Card size="small"><strong>{state.data.counts.owned_sessions}</strong><br />{t('overview.ownedCount')}</Card>
          <Card size="small"><strong>{state.data.counts.memberships}</strong><br />{t('overview.sessionCount')}</Card>
          <Card size="small"><strong>{state.data.counts.active_device_sessions}</strong><br />{t('account.devices')}</Card>
          <Card size="small"><strong>{formatBytes(state.data.counts.personal_record_snapshot_bytes, locale)}</strong><br />{t('personalCloud.recordStorage')}</Card>
          <Card size="small"><strong>{formatBytes(state.data.counts.personal_dictionary_snapshot_bytes, locale)}</strong><br />{t('personalCloud.dictionaryStorage')}</Card>
        </div>
        {!user.deletedAt && <Card size="small" title={t('common.actions')} style={{ marginTop: 16 }}><Alert showIcon type="warning" message={t('admin.reauthenticateHint')} style={{ marginBottom: 12 }} /><Space wrap>
          {user.id !== currentUserId && <Button onClick={() => setAction({ title: t('admin.resetPassword'), resetPassword: true, run: (reason) => adminApi.resetPassword(user.id, reason) })}>{t('admin.resetPassword')}</Button>}
          {user.id !== currentUserId && <Button onClick={() => setAction({ title: user.loginNeverExpires ? t('admin.disableNeverExpires') : t('admin.enableNeverExpires'), run: (reason) => adminApi.setLoginNeverExpires(user.id, !user.loginNeverExpires, reason) })}>{user.loginNeverExpires ? t('admin.disableNeverExpires') : t('admin.enableNeverExpires')}</Button>}
          {user.id !== currentUserId && <Button danger={!user.disabledAt} onClick={() => setAction({ title: user.disabledAt ? t('admin.enableUser') : t('admin.disableUser'), run: (reason) => adminApi.setUserEnabled(user.id, Boolean(user.disabledAt), reason) })}>{user.disabledAt ? t('admin.enableUser') : t('admin.disableUser')}</Button>}
          {user.id !== currentUserId && user.disabledAt && <Button danger onClick={() => setAction({ title: t('common.delete'), run: (reason) => adminApi.deleteUser(user.id, reason) })}>{t('common.delete')}</Button>}
        </Space></Card>}
        <Card size="small" title={t('account.devices')} className="table-card" style={{ marginTop: 16 }}><Table rowKey="sessionId" size="small" pagination={false} dataSource={state.data.deviceSessions} scroll={{ x: 700 }} columns={[
          { title: t('account.device'), dataIndex: 'deviceId', render: (value: string | null) => value ?? '—' },
          { title: 'User-Agent', dataIndex: 'userAgent', ellipsis: true },
          { title: t('account.lastUsed'), dataIndex: 'lastUsedAt', render: (value: string | null) => value ? new Date(value).toLocaleString(locale) : '—' },
          { title: t('account.expires'), dataIndex: 'expiresAt', render: (value: string) => user.loginNeverExpires ? <Tag color="blue">{t('admin.neverExpires')}</Tag> : new Date(value).toLocaleString(locale) },
        ]} /></Card>
      </>}
    </AsyncContent>
  </Drawer>
  <Modal open={Boolean(action)} title={action?.title} okText={t('common.save')} cancelText={t('common.cancel')} confirmLoading={working} closable={!working} maskClosable={!working} keyboard={!working} cancelButtonProps={{ disabled: working }} onOk={() => void execute()} onCancel={() => { setAction(null); form.resetFields(); }}><Alert type="warning" showIcon message={t('admin.reauthenticateHint')} style={{ marginBottom: 16 }} /><Form form={form} layout="vertical"><Form.Item name="password" label={t('auth.password')} rules={[{ required: true }]}><Input.Password /></Form.Item><Form.Item name="reason" label={t('admin.reason')} rules={[{ required: true }, { min: 3 }, { max: 500 }]}><Input.TextArea rows={3} /></Form.Item></Form></Modal>
  <Modal open={Boolean(temporary)} title={t('admin.temporaryPassword')} footer={<Button type="primary" onClick={() => setTemporary(null)}>{t('common.close')}</Button>} onCancel={() => setTemporary(null)} closable={false}><Alert type="warning" showIcon message={t('admin.temporaryPasswordHint')} /><Input value={temporary?.temporaryPassword ?? ''} readOnly style={{ marginTop: 16 }} addonAfter={<Button type="text" icon={<CopyOutlined />} onClick={() => { void navigator.clipboard.writeText(temporary?.temporaryPassword ?? ''); messageApi.success(t('common.copied')); }}>{t('common.copy')}</Button>} /></Modal>
  </>;
}

export default function UsersPage() {
  const { user: current } = useAuth();
  const { t, locale } = useI18n();
  const [messageApi, contextHolder] = message.useMessage();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<string>();
  const [action, setAction] = useState<SensitiveAction | null>(null);
  const [actionForm] = Form.useForm();
  const [working, setWorking] = useState(false);
  const state = useAsync(() => adminApi.users({ page, pageSize, q: query || undefined, role }), [page, pageSize, query, role]);
  useEffect(() => setPage(1), [query, role]);
  const execute = async () => {
    if (!action) return;
    let values: { password: string; reason: string };
    try { values = await actionForm.validateFields(); } catch { return; }
    setWorking(true);
    try {
      await adminApi.elevate(values.password);
      await action.run(values.reason.trim());
      setAction(null);
      actionForm.resetFields();
      state.reload();
      messageApi.success(t('settings.applied'));
    } catch (error) {
      messageApi.error(error instanceof ApiError ? `${error.message} (${error.code})` : t('error.default'));
    } finally { setWorking(false); }
  };
  return <>{contextHolder}<PageHeader title={t('admin.userManagement')} actions={<Button icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>} />
    <Card className="surface table-card" title={<Space className="table-toolbar" wrap><Input.Search className="table-toolbar-search" allowClear prefix={<SearchOutlined />} placeholder={t('common.search')} value={input} onChange={(event) => setInput(event.target.value)} onSearch={() => setQuery(input.trim())} /><Select allowClear placeholder={t('common.role')} value={role} onChange={setRole} style={{ width: 150 }} options={[{ value: 'admin', label: t('role.admin') }, { value: 'user', label: t('role.user') }]} /></Space>}>
      <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.items.length} onRetry={state.reload}>
        <Table<User> rowKey="id" dataSource={state.data?.items ?? []} scroll={{ x: 960 }} pagination={{ current: page, pageSize, total: state.data?.total, showSizeChanger: true, onChange: (next, size) => { setPage(next); setPageSize(size); } }} columns={[
          { title: t('auth.username'), dataIndex: 'username', render: (value: string, row) => <div><strong>{value}</strong>{row.id === current?.id && <Tag color="blue" style={{ marginInlineStart: 8 }}>{t('account.current')}</Tag>}<br /><span className="error-code">{row.id}</span></div> },
          { title: t('common.role'), dataIndex: 'role', width: 180, render: (value: User['role'], row) => <Select disabled={row.id === current?.id} value={value} style={{ width: 135 }} options={[{ value: 'admin', label: t('role.admin') }, { value: 'user', label: t('role.user') }]} onChange={(next) => setAction({ title: t('admin.changeRole'), run: (reason) => adminApi.updateRole(row.id, next, reason) })} /> },
          { title: t('admin.loginExpiration'), dataIndex: 'loginNeverExpires', width: 150, render: (value?: boolean) => value ? <Tag color="blue">{t('admin.neverExpires')}</Tag> : t('admin.standardExpiration') },
          { title: t('sessions.createdAt'), dataIndex: 'createdAt', width: 190, render: (value?: string) => value ? new Date(value).toLocaleString(locale) : '—' },
          { title: t('common.actions'), width: 270, render: (_, row) => <Space size={0}><Button type="link" icon={<EyeOutlined />} onClick={() => setSelectedUserId(row.id)}>{t('common.details')}</Button><Button danger type="link" icon={<StopOutlined />} onClick={() => setAction({ title: t('admin.revokeTokens'), run: (reason) => adminApi.revokeTokens(row.id, reason) })}>{t('admin.revokeTokens')}</Button></Space> },
        ]} />
      </AsyncContent>
    </Card>
    {selectedUserId && <UserDetailDrawer userId={selectedUserId} currentUserId={current?.id} onClose={() => setSelectedUserId(null)} onChanged={state.reload} />}
    <Modal open={Boolean(action)} title={action?.title} okText={t('common.save')} cancelText={t('common.cancel')} confirmLoading={working} closable={!working} maskClosable={!working} keyboard={!working} cancelButtonProps={{ disabled: working }} onOk={() => void execute()} onCancel={() => { setAction(null); actionForm.resetFields(); }}><Alert type="warning" showIcon message={t('admin.reauthenticateHint')} style={{ marginBottom: 16 }} /><Form form={actionForm} layout="vertical"><Form.Item name="password" label={t('auth.password')} rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item><Form.Item name="reason" label={t('admin.reason')} rules={[{ required: true }, { min: 3 }, { max: 500 }]}><Input.TextArea rows={3} maxLength={500} showCount /></Form.Item></Form></Modal>
  </>;
}
