import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import { ApiError, archiveApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import type { AvailableArchiveSourceSession, PublicArchiveList, PublicArchiveSession } from '../../types';
import { useI18n } from '../../useI18n';
import { archiveListPublicUrl } from '../../utils/publicArchiveUrls';

function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : fallback;
}

export default function PublicArchiveListsPage() {
  const { t, locale } = useI18n();
  const [messageApi, contextHolder] = message.useMessage();
  const [listPage, setListPage] = useState(1); const [listPageSize, setListPageSize] = useState(25);
  const lists = useAsync(() => archiveApi.list({ page: listPage, pageSize: listPageSize }), [listPage, listPageSize]);
  const [selected, setSelected] = useState<PublicArchiveList | null>(null);
  const [sessions, setSessions] = useState<PublicArchiveSession[]>([]);
  const [editor, setEditor] = useState<PublicArchiveList | 'new' | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [accountKind, setAccountKind] = useState<'members' | 'sources'>('members');
  const [accountId, setAccountId] = useState('');
  const [source, setSource] = useState<'personal' | 'collaboration'>();
  const [availablePage, setAvailablePage] = useState(1); const [availablePageSize, setAvailablePageSize] = useState(25);
  const manager = selected?.capabilities?.canManageAccounts;
  const canManageContents = selected?.capabilities?.canManageContents;
  const available = useAsync(() => selected ? archiveApi.availableSessions(selected.id, { page: availablePage, pageSize: availablePageSize, source }) : Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 }), [selected?.id, availablePage, availablePageSize, source]);
  const detail = useAsync(() => selected ? archiveApi.detail(selected.id) : Promise.resolve(null), [selected?.id]);
  const accounts = useAsync(() => selected && manager ? (accountKind === 'members' ? archiveApi.members(selected.id) : archiveApi.sources(selected.id)) : Promise.resolve([]), [selected?.id, manager, accountKind]);
  const [form] = Form.useForm<{ title: string }>();
  const reloadSelected = () => { detail.reload(); available.reload(); accounts.reload(); };
  const refresh = () => { lists.reload(); reloadSelected(); };

  useEffect(() => {
    if (detail.data) {
      setSelected(detail.data);
      setSessions(detail.data.sessions ?? []);
    }
  }, [detail.data]);

  const saveTitle = async () => {
    const { title } = await form.validateFields();
    try {
      const result = editor === 'new' ? await archiveApi.create(title.trim()) : await archiveApi.update(editor!.id, title.trim());
      setEditor(null); form.resetFields(); setSelected(result); refresh();
    } catch (error) { messageApi.error(errorMessage(error, t('error.default'))); }
  };
  const addSnapshot = async (row: AvailableArchiveSourceSession) => {
    if (!selected) return;
    try {
      await archiveApi.addSession(selected.id, { sourceUserId: row.ownerUserId, sourceKind: row.source, sourceSessionId: row.sessionId });
      setPickerOpen(false); refresh();
    } catch (error) { messageApi.error(errorMessage(error, t('error.default'))); }
  };
  const mutate = async (action: () => Promise<unknown>) => { try { await action(); refresh(); } catch (error) { messageApi.error(errorMessage(error, t('error.default'))); } };
  const reorder = (session: PublicArchiveSession, direction: -1 | 1) => {
    if (!selected) return;
    const index = sessions.findIndex((item) => item.id === session.id); const target = index + direction;
    if (target < 0 || target >= sessions.length) return;
    const next = [...sessions]; [next[index], next[target]] = [next[target], next[index]];
    void mutate(() => archiveApi.reorderSessions(selected.id, next.map((item) => item.id)));
  };
  const copy = (path: string) => { void window.navigator.clipboard.writeText(`${window.location.origin}${path}`); messageApi.success(t('common.copied')); };

  return <>{contextHolder}<PageHeader title={t('archives.memberTitle')} description={t('archives.memberDescription')} actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setEditor('new'); }}>{t('archives.create')}</Button>} />
    <Card className="surface table-card" title={t('archives.lists')} extra={<Button icon={<ReloadOutlined />} onClick={refresh}>{t('common.refresh')}</Button>}>
      <AsyncContent loading={lists.loading} error={lists.error} empty={!lists.loading && !lists.data?.items.length} onRetry={lists.reload}>
        <Table<PublicArchiveList> rowKey="id" dataSource={lists.data?.items} pagination={{ current: listPage, pageSize: listPageSize, total: lists.data?.total, onChange: (next, size) => { setListPage(next); setListPageSize(size); } }} scroll={{ x: 780 }} columns={[
          { title: t('common.name'), dataIndex: 'title', render: (title: string, row) => <Button type="link" onClick={() => { setSelected(row); setSessions(row.sessions ?? []); }}>{title}</Button> },
          { title: t('common.status'), dataIndex: 'isPublished', render: (published: boolean) => <Tag color={published ? 'green' : 'default'}>{published ? t('archives.published') : t('archives.unpublished')}</Tag> },
          { title: t('common.actions'), width: 300, render: (_: unknown, row) => <Space wrap><Button onClick={() => { setSelected(row); setSessions(row.sessions ?? []); }}>{t('archives.manage')}</Button><Button icon={<EditOutlined />} onClick={() => { form.setFieldValue('title', row.title); setEditor(row); }}>{t('common.edit')}</Button><Popconfirm title={t('archives.deleteConfirm')} onConfirm={() => void mutate(() => archiveApi.remove(row.id))}><Button danger icon={<DeleteOutlined />}>{t('common.delete')}</Button></Popconfirm></Space> },
        ]} />
      </AsyncContent>
    </Card>
    {selected && <Card className="surface" style={{ marginTop: 16 }} title={selected.title} extra={<Space><Button onClick={() => void (async () => { try { const next = selected.isPublished ? await archiveApi.unpublish(selected.id) : await archiveApi.publish(selected.id); setSelected(next); refresh(); } catch (error) { messageApi.error(errorMessage(error, t('error.default'))); } })()}>{selected.isPublished ? t('archives.unpublish') : t('archives.publish')}</Button>{selected.isPublished && <Button icon={<CopyOutlined />} onClick={() => copy(archiveListPublicUrl(selected.id))}>{t('archives.copyPublicLink')}</Button>}</Space>}>
      {!manager && <Alert type="info" showIcon title={t('archives.memberManagerHint')} style={{ marginBottom: 16 }} />}
      {canManageContents && <Button type="primary" icon={<PlusOutlined />} onClick={() => setPickerOpen(true)}>{t('archives.addClosedSession')}</Button>}
      <Table<PublicArchiveSession> style={{ marginTop: 16 }} rowKey="id" dataSource={sessions} pagination={false} locale={{ emptyText: t('archives.snapshotUnavailable') }} columns={[
        { title: t('sessions.session'), dataIndex: 'title' }, { title: t('sessions.updatedAt'), dataIndex: 'closedAt', render: (value) => new Date(value).toLocaleString(locale) },
        { title: t('common.actions'), render: (_: unknown, row) => canManageContents && <Space><Button onClick={() => void mutate(() => archiveApi.refreshSession(selected.id, row.id))}>{t('common.refresh')}</Button><Button onClick={() => reorder(row, -1)} disabled={sessions[0]?.id === row.id}>{t('archives.moveUp')}</Button><Button onClick={() => reorder(row, 1)} disabled={sessions.at(-1)?.id === row.id}>{t('archives.moveDown')}</Button><Popconfirm title={t('archives.removeSnapshotConfirm')} onConfirm={() => void mutate(() => archiveApi.removeSession(selected.id, row.id))}><Button danger>{t('common.delete')}</Button></Popconfirm></Space> },
      ]} />
      {manager && <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>{t('archives.membersSourcesHint')}</Typography.Paragraph>}
      {manager && <Button onClick={() => setAccountsOpen(true)}>{t('archives.manageAccounts')}</Button>}
    </Card>}
    <Modal open={editor !== null} title={editor === 'new' ? t('archives.create') : t('archives.editTitle')} onCancel={() => setEditor(null)} onOk={() => void saveTitle()} okText={editor === 'new' ? t('common.create') : t('common.save')}><Form form={form} layout="vertical"><Form.Item name="title" label={t('archives.title')} rules={[{ required: true }]}><Input autoFocus maxLength={256} /></Form.Item></Form></Modal>
    <Modal open={pickerOpen} title={t('archives.addClosedSession')} footer={null} onCancel={() => setPickerOpen(false)} width={850}><Select allowClear placeholder={t('sessions.type')} value={source} onChange={(value) => { setSource(value); setAvailablePage(1); }} style={{ width: 180, marginBottom: 16 }} options={[{ value: 'collaboration', label: t('sessionSource.collaboration') }, { value: 'personal', label: t('sessionSource.personal') }]} /><AsyncContent loading={available.loading} error={available.error} empty={!available.loading && !available.data?.items.length} onRetry={available.reload}><Table<AvailableArchiveSourceSession> rowKey={(row) => `${row.source}:${row.sessionId}`} dataSource={available.data?.items} pagination={{ current: availablePage, pageSize: availablePageSize, total: available.data?.total, onChange: (next, size) => { setAvailablePage(next); setAvailablePageSize(size); } }} columns={[{ title: t('sessions.session'), dataIndex: 'title' }, { title: t('sessionSource.personalOwner'), dataIndex: 'ownerUsername' }, { title: t('sessions.logs'), dataIndex: 'logCount' }, { title: t('common.actions'), render: (_: unknown, row) => <Button onClick={() => void addSnapshot(row)}>{t('archives.add')}</Button> }]} /></AsyncContent></Modal>
    <Modal open={accountsOpen} title={t('archives.manageAccounts')} footer={null} onCancel={() => setAccountsOpen(false)}><Space direction="vertical" style={{ width: '100%' }}><Select value={accountKind} onChange={setAccountKind} options={[{ value: 'members', label: t('archives.members') }, { value: 'sources', label: t('archives.sources') }]} /><Space.Compact style={{ width: '100%' }}><Input value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder={t('archives.userId')} /><Button disabled={!accountId.trim() || !selected} onClick={() => void mutate(async () => { if (!selected) return; if (accountKind === 'members') await archiveApi.addMember(selected.id, accountId.trim()); else await archiveApi.addSource(selected.id, accountId.trim()); setAccountId(''); accounts.reload(); })}>{t('archives.add')}</Button></Space.Compact><Table rowKey="userId" size="small" dataSource={accounts.data ?? []} pagination={false} columns={[{ title: t('archives.userId'), dataIndex: 'userId' }, { title: t('common.actions'), render: (_: unknown, row: { userId: string }) => <Button danger onClick={() => void mutate(async () => { if (!selected) return; if (accountKind === 'members') await archiveApi.removeMember(selected.id, row.userId); else await archiveApi.removeSource(selected.id, row.userId); accounts.reload(); })}>{t('common.delete')}</Button> }]} /></Space></Modal>
  </>;
}
