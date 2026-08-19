import { CopyOutlined, DeleteOutlined, EditOutlined, LinkOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Modal, Popconfirm, Space, Table, Tag, message } from 'antd';
import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ApiError, archiveApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import type { PublicArchiveList } from '../../types';
import { useI18n } from '../../useI18n';
import { archiveAliasPublicUrl, archiveListPublicUrl } from '../../utils/publicArchiveUrls';

function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : fallback;
}

export default function PublicArchiveListsPage() {
  const { t } = useI18n();
  const [messageApi, contextHolder] = message.useMessage();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [editor, setEditor] = useState<PublicArchiveList | 'new' | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [form] = Form.useForm<{ title: string }>();
  const lists = useAsync(() => archiveApi.list({ page, pageSize }), [page, pageSize]);

  useEffect(() => {
    if (lists.data?.total && !lists.data.items.length && page > 1) setPage((current) => Math.min(current - 1, lists.data!.totalPages || 1));
  }, [lists.data, page]);

  const copy = async (path: string) => {
    try {
      if (!window.navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await window.navigator.clipboard.writeText(`${window.location.origin}${path}`);
      messageApi.success(t('common.copied'));
    } catch { messageApi.error(t('error.default')); }
  };
  const save = async () => {
    const { title } = await form.validateFields();
    try {
      if (editor === 'new') await archiveApi.create(title.trim());
      else if (editor) await archiveApi.update(editor.id, title.trim());
      setEditor(null);
      form.resetFields();
      lists.reload();
    } catch (error) { messageApi.error(errorMessage(error, t('error.default'))); }
  };
  const remove = async (listId: string) => {
    try { await archiveApi.remove(listId); lists.reload(); } catch (error) { messageApi.error(errorMessage(error, t('error.default'))); }
  };
  const togglePublished = async (row: PublicArchiveList) => {
    setPublishError(null);
    try {
      if (row.isPublished) await archiveApi.unpublish(row.id);
      else await archiveApi.publish(row.id);
      lists.reload();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ARCHIVE_LIST_EMPTY') setPublishError(t('archives.emptyPublishError'));
      else messageApi.error(errorMessage(error, t('error.default')));
    }
  };

  return <>{contextHolder}<PageHeader title={t('archives.memberTitle')} description={t('archives.memberDescription')} actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setEditor('new'); }}>{t('archives.create')}</Button>} />
    {publishError && <Alert type="error" showIcon title={publishError} closable onClose={() => setPublishError(null)} style={{ marginBottom: 16 }} />}
    <Card className="surface table-card" title={t('archives.lists')} extra={<Button icon={<ReloadOutlined />} onClick={lists.reload}>{t('common.refresh')}</Button>}>
      <AsyncContent loading={lists.loading} error={lists.error} empty={!lists.loading && !lists.data?.items.length} onRetry={lists.reload}>
        <Table<PublicArchiveList> rowKey="id" dataSource={lists.data?.items} scroll={{ x: 950 }} pagination={{ current: page, pageSize, total: lists.data?.total, onChange: (next, size) => { setPage(next); setPageSize(size); } }} columns={[
          { title: t('common.name'), dataIndex: 'title', render: (title: string, row) => <Link to={`/app/public-archives/${row.id}`}>{title}</Link> },
          { title: t('archives.owner'), dataIndex: 'ownerUsername' },
          { title: t('archives.alias'), dataIndex: 'displayAlias', render: (alias: string | undefined, row) => row.isPublished ? (alias ? <Tag>{alias}</Tag> : archiveListPublicUrl(row.id)) : '-' },
          { title: t('common.status'), dataIndex: 'isPublished', render: (published: boolean) => <Tag color={published ? 'green' : 'default'}>{published ? t('archives.published') : t('archives.unpublished')}</Tag> },
          { title: t('common.actions'), width: 390, render: (_: unknown, row) => {
            const publicUrl = row.displayAlias ? archiveAliasPublicUrl(row.displayAlias) : archiveListPublicUrl(row.id);
            return <Space wrap><Button onClick={() => void togglePublished(row)}>{row.isPublished ? t('archives.unpublish') : t('archives.publish')}</Button>{row.isPublished && <><Button icon={<CopyOutlined />} onClick={() => void copy(publicUrl)}>{t('archives.copyPublicLink')}</Button><Button icon={<LinkOutlined />} href={publicUrl} target="_blank">{t('archives.openPublicPage')}</Button></>}<Button icon={<EditOutlined />} onClick={() => { form.setFieldValue('title', row.title); setEditor(row); }}>{t('common.edit')}</Button><Popconfirm title={t('archives.deleteConfirm')} onConfirm={() => void remove(row.id)}><Button danger icon={<DeleteOutlined />}>{t('common.delete')}</Button></Popconfirm></Space>;
          } },
        ]} />
      </AsyncContent>
    </Card>
    <Modal open={editor !== null} title={editor === 'new' ? t('archives.create') : t('archives.editTitle')} onCancel={() => setEditor(null)} onOk={() => void save()} okText={editor === 'new' ? t('common.create') : t('common.save')}><Form form={form} layout="vertical"><Form.Item name="title" label={t('archives.title')} rules={[{ required: true }]}><Input autoFocus maxLength={256} /></Form.Item></Form></Modal>
  </>;
}
