import { CopyOutlined, DeleteOutlined, EditOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Modal, Popconfirm, Space, Table, Tag, message } from 'antd';
import { useState } from 'react';
import { adminArchiveApi, ApiError, archiveApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import type { PublicArchiveList } from '../../types';
import { useI18n } from '../../useI18n';
import { archiveAliasPublicUrl } from '../../utils/publicArchiveUrls';

export default function PublicArchiveListsPage() {
  const { t } = useI18n(); const [messageApi, contextHolder] = message.useMessage();
  const lists = useAsync(() => archiveApi.list({ page: 1, pageSize: 100 }), []);
  const [editing, setEditing] = useState<PublicArchiveList | null>(null); const [serverError, setServerError] = useState<string | null>(null);
  const [form] = Form.useForm<{ alias: string }>();
  const refresh = () => lists.reload();
  const errorText = (error: unknown) => error instanceof ApiError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : (error as { message?: string })?.message ?? t('error.default');
  const save = async () => { if (!editing) return; const { alias } = await form.validateFields(); setServerError(null); try { const result = await adminArchiveApi.setAlias(editing.id, alias); lists.setData((page) => page && { ...page, items: page.items.map((item) => item.id === result.id ? { ...item, alias: result.alias } : item) }); setEditing(null); } catch (error) { setServerError(errorText(error)); } };
  const copy = (path: string) => { void window.navigator.clipboard.writeText(`${window.location.origin}${path}`); messageApi.success(t('common.copied')); };
  return <>{contextHolder}<PageHeader title={t('archives.adminTitle')} description={t('archives.adminDescription')} actions={<Button icon={<ReloadOutlined />} onClick={refresh}>{t('common.refresh')}</Button>} />
    <Card className="surface table-card"><AsyncContent loading={lists.loading} error={lists.error} empty={!lists.loading && !lists.data?.items.length} onRetry={refresh}><Table<PublicArchiveList> rowKey="id" dataSource={lists.data?.items} pagination={false} scroll={{ x: 800 }} columns={[
      { title: t('common.name'), dataIndex: 'title' }, { title: t('archives.owner'), dataIndex: 'ownerUserId' }, { title: t('common.status'), dataIndex: 'isPublished', render: (published: boolean) => <Tag color={published ? 'green' : 'default'}>{published ? t('archives.published') : t('archives.unpublished')}</Tag> },
      { title: t('archives.alias'), dataIndex: 'alias', render: (alias: string | null | undefined) => alias ?? '-' },
      { title: t('common.actions'), width: 320, render: (_: unknown, row) => <Space wrap><Button icon={<EditOutlined />} onClick={() => { form.setFieldValue('alias', row.alias ?? ''); setServerError(null); setEditing(row); }}>{row.alias ? t('archives.replaceAlias') : t('archives.setAlias')}</Button>{row.alias && <Button icon={<CopyOutlined />} onClick={() => copy(archiveAliasPublicUrl(row.alias!))}>{t('archives.copyPublicLink')}</Button>}{row.alias && <Popconfirm title={t('archives.deleteAliasConfirm')} onConfirm={() => void adminArchiveApi.removeAlias(row.id).then(refresh).catch((error) => messageApi.error(errorText(error)))}><Button danger icon={<DeleteOutlined />}>{t('common.delete')}</Button></Popconfirm>}</Space> },
    ]} /></AsyncContent></Card>
    <Modal open={Boolean(editing)} title={t('archives.setAlias')} onCancel={() => setEditing(null)} onOk={() => void save()} okText={t('common.save')}><Form form={form} layout="vertical"><Form.Item name="alias" label={t('archives.alias')} rules={[{ required: true }]}><Input autoFocus maxLength={63} /></Form.Item></Form>{serverError && <Alert type="error" showIcon title={serverError} />}</Modal>
  </>;
}
