import { SaveOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Switch, Typography, message } from 'antd';
import { useState } from 'react';
import { adminApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';

interface OperationalForm {
  corsOrigins: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  rateLimitEnabled: boolean;
  port: number;
  trustProxy: string;
  jsonBodyLimit: string;
}

export default function AdminSettingsPage() {
  const { t } = useI18n();
  const basic = useAsync(adminApi.settings, []);
  const operational = useAsync(adminApi.operationalSettings, []);
  const [messageApi, contextHolder] = message.useMessage();
  const [pending, setPending] = useState<OperationalForm | null>(null);
  const [registrationPending, setRegistrationPending] = useState<boolean | null>(null);
  const [reauthForm] = Form.useForm();
  const [registrationForm] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [registrationSaving, setRegistrationSaving] = useState(false);
  const effective = operational.data?.desired ?? {};
  const initial: OperationalForm = {
    corsOrigins: Array.isArray(effective.corsOrigins) ? effective.corsOrigins.join('\n') : '',
    accessTokenTtlSeconds: Number(effective.accessTokenTtlSeconds ?? 900),
    refreshTokenTtlSeconds: Number(effective.refreshTokenTtlSeconds ?? 2_592_000),
    rateLimitEnabled: Boolean(effective.rateLimitEnabled),
    port: Number(effective.port ?? 3000),
    trustProxy: String(effective.trustProxy ?? 'false'),
    jsonBodyLimit: String(effective.jsonBodyLimit ?? '1mb'),
  };
  const applyOperational = async () => {
    if (!pending) return;
    const { password, reason } = await reauthForm.validateFields();
    const trustValue = pending.trustProxy.trim().toLowerCase();
    const trustProxy = trustValue === 'true' ? true : trustValue === 'false' ? false : Number(trustValue);
    setSaving(true);
    try {
      await adminApi.elevate(password);
      await adminApi.updateOperationalSettings({
        ...pending,
        corsOrigins: pending.corsOrigins.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        trustProxy,
      }, reason.trim());
      messageApi.success(t('settings.applied')); setPending(null); reauthForm.resetFields(); operational.reload();
    } finally { setSaving(false); }
  };
  const applyRegistration = async () => {
    if (registrationPending === null) return;
    const { password, reason } = await registrationForm.validateFields();
    setRegistrationSaving(true);
    try {
      await adminApi.elevate(password);
      await adminApi.updateSettings(registrationPending, reason.trim());
      messageApi.success(t('settings.applied'));
      setRegistrationPending(null);
      registrationForm.resetFields();
      basic.reload();
    } finally { setRegistrationSaving(false); }
  };
  return <>{contextHolder}<PageHeader title={t('admin.settings')} />
    <div className="content-grid">
      <Card className="surface" title={t('settings.registration')}>
        <AsyncContent loading={basic.loading} error={basic.error} onRetry={basic.reload}>
          {basic.data && <Form layout="vertical" initialValues={basic.data} onFinish={({ registrationEnabled }: { registrationEnabled: boolean }) => setRegistrationPending(registrationEnabled)}>
            <Form.Item name="registrationEnabled" label={t('settings.registration')} valuePropName="checked"><Switch /></Form.Item>
            <Typography.Paragraph type="secondary">{t('settings.registrationHint')}</Typography.Paragraph>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />}>{t('common.save')}</Button>
          </Form>}
        </AsyncContent>
      </Card>
      <Card className="surface" title={t('admin.settings')}>
        <AsyncContent loading={operational.loading} error={operational.error} onRetry={operational.reload}>
          {operational.data && <Form<OperationalForm> layout="vertical" initialValues={initial} onFinish={setPending}>
            {operational.data.restartRequired && <Alert type="warning" showIcon message={`Restart required: ${operational.data.restartRequiredKeys.join(', ')}`} style={{ marginBottom: 16 }} />}
            <Form.Item name="corsOrigins" label="CORS origins"><Input.TextArea rows={3} placeholder="https://example.com" /></Form.Item>
            <div className="content-grid"><Form.Item name="accessTokenTtlSeconds" label="Access token TTL (s)" rules={[{ required: true }]}><InputNumber min={60} style={{ width: '100%' }} /></Form.Item><Form.Item name="refreshTokenTtlSeconds" label="Refresh token TTL (s)" rules={[{ required: true }]}><InputNumber min={60} style={{ width: '100%' }} /></Form.Item></div>
            <Form.Item name="rateLimitEnabled" label="Rate limiting" valuePropName="checked"><Switch /></Form.Item>
            <div className="content-grid"><Form.Item name="port" label="Port"><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item><Form.Item name="trustProxy" label="Trust proxy"><Input placeholder="false / true / hop count" /></Form.Item></div>
            <Form.Item name="jsonBodyLimit" label="JSON body limit"><Input placeholder="1mb" /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />}>{t('common.save')}</Button>
          </Form>}
        </AsyncContent>
      </Card>
    </div>
    {operational.data && <Card className="surface" title="Read-only environment" style={{ marginTop: 16 }}><pre className="json-preview">{JSON.stringify(operational.data.readOnly, null, 2)}</pre></Card>}
    <Modal open={registrationPending !== null} title={t('admin.reauthenticate')} okText={t('common.save')} cancelText={t('common.cancel')} confirmLoading={registrationSaving} onOk={() => void applyRegistration()} onCancel={() => { setRegistrationPending(null); registrationForm.resetFields(); }}><Alert type="warning" showIcon message={t('admin.reauthenticateHint')} style={{ marginBottom: 16 }} /><Form form={registrationForm} layout="vertical"><Form.Item name="password" label={t('auth.password')} rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item><Form.Item name="reason" label={t('admin.reason')} rules={[{ required: true }, { min: 3 }, { max: 500 }]}><Input.TextArea rows={3} maxLength={500} showCount /></Form.Item></Form></Modal>
    <Modal open={Boolean(pending)} title={t('admin.reauthenticate')} okText={t('common.save')} cancelText={t('common.cancel')} confirmLoading={saving} onOk={() => void applyOperational()} onCancel={() => { setPending(null); reauthForm.resetFields(); }}><Alert type="warning" showIcon message={t('admin.reauthenticateHint')} style={{ marginBottom: 16 }} /><Form form={reauthForm} layout="vertical"><Form.Item name="password" label={t('auth.password')} rules={[{ required: true }]}><Input.Password /></Form.Item><Form.Item name="reason" label={t('admin.reason')} rules={[{ required: true }, { min: 3 }, { max: 500 }]}><Input.TextArea rows={3} /></Form.Item></Form></Modal>
  </>;
}
