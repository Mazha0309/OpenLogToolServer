import { DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Space, message } from 'antd';
import { useState } from 'react';
import { adminApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';

export default function OperationsPage() {
  const { t } = useI18n();
  const metrics = useAsync(adminApi.metrics, []);
  const [days, setDays] = useState(30);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [working, setWorking] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupForm] = Form.useForm();
  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruneForm] = Form.useForm();
  const [pruning, setPruning] = useState(false);
  const previewRetention = async () => {
    setWorking(true);
    try {
      setPreview(await adminApi.retentionPreview(days));
    } finally { setWorking(false); }
  };
  const pruneRetention = async () => {
    const { password, reason } = await pruneForm.validateFields();
    setPruning(true);
    try {
      await adminApi.elevate(password);
      const result = await adminApi.retentionPrune(days, reason.trim());
      setPreview(result);
      setPruneOpen(false);
      pruneForm.resetFields();
      messageApi.success(t('settings.applied'));
      metrics.reload();
    } finally { setPruning(false); }
  };
  return <>{contextHolder}<PageHeader title={t('nav.operations')} actions={<Button icon={<ReloadOutlined />} onClick={metrics.reload}>{t('common.refresh')}</Button>} />
    <div className="content-grid">
      <Card className="surface" title={t('admin.runtime')}>
        <AsyncContent loading={metrics.loading} error={metrics.error} onRetry={metrics.reload}>{metrics.data && <pre className="json-preview">{JSON.stringify(metrics.data, null, 2)}</pre>}</AsyncContent>
      </Card>
      <Card className="surface" title={t('admin.retention')}>
        <Alert showIcon type="warning" message={t('admin.pruneWarning')} style={{ marginBottom: 18 }} />
        <Form layout="vertical"><Form.Item label={t('admin.retentionDays')}><InputNumber min={1} max={3650} value={days} onChange={(value) => setDays(value ?? 30)} style={{ width: '100%' }} /></Form.Item></Form>
        <Space wrap><Button icon={<SearchOutlined />} loading={working} onClick={() => void previewRetention()}>{t('admin.preview')}</Button><Button danger type="primary" icon={<DeleteOutlined />} onClick={() => setPruneOpen(true)}>{t('admin.prune')}</Button></Space>
        {preview && <pre className="json-preview" style={{ marginTop: 18 }}>{JSON.stringify(preview, null, 2)}</pre>}
      </Card>
    </div>
    <Card className="surface" title={t('admin.backup')} style={{ marginTop: 16 }}><Alert showIcon type="info" message={t('admin.reauthenticateHint')} style={{ marginBottom: 16 }} /><Button type="primary" onClick={() => setBackupOpen(true)}>{t('admin.downloadBackup')}</Button></Card>
    <Modal open={pruneOpen} title={t('admin.prune')} okText={t('admin.prune')} cancelText={t('common.cancel')} confirmLoading={pruning} onCancel={() => { setPruneOpen(false); pruneForm.resetFields(); }} onOk={() => void pruneRetention()}><Alert type="warning" showIcon message={t('admin.pruneWarning')} style={{ marginBottom: 16 }} /><Form form={pruneForm} layout="vertical"><Form.Item name="password" label={t('auth.password')} rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item><Form.Item name="reason" label={t('admin.reason')} rules={[{ required: true }, { min: 3 }, { max: 500 }]}><Input.TextArea rows={3} maxLength={500} showCount /></Form.Item></Form></Modal>
    <Modal open={backupOpen} title={t('admin.backup')} okText={t('admin.downloadBackup')} cancelText={t('common.cancel')} onCancel={() => { setBackupOpen(false); backupForm.resetFields(); }} onOk={async () => { const { password, reason } = await backupForm.validateFields(); await adminApi.elevate(password); await adminApi.downloadBackup(reason.trim()); setBackupOpen(false); backupForm.resetFields(); }}><Form form={backupForm} layout="vertical"><Form.Item name="password" label={t('auth.password')} rules={[{ required: true }]}><Input.Password /></Form.Item><Form.Item name="reason" label={t('admin.reason')} rules={[{ required: true }, { min: 3 }]}><Input.TextArea rows={3} /></Form.Item></Form></Modal>
  </>;
}
