import {
  BookOutlined,
  CloudOutlined,
  DatabaseOutlined,
  EyeOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Input, Table, Tabs, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import type {
  AdminPersonalDictionarySnapshotItem,
  AdminPersonalSnapshotItem,
} from '../../types';
import { useI18n } from '../../useI18n';
import {
  type PersonalCloudDataset,
  adminPersonalSnapshotDetailRoute,
} from '../../utils/personalCloud';

export default function AdminPersonalSnapshotsPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [dataset, setDataset] = useState<PersonalCloudDataset>('records');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const recordsState = useAsync(
    () => adminApi.personalSnapshots({ page, pageSize, q: query || undefined }),
    [page, pageSize, query],
  );
  const dictionariesState = useAsync(
    () => adminApi.personalDictionarySnapshots({ page, pageSize, q: query || undefined }),
    [page, pageSize, query],
  );
  useEffect(() => setPage(1), [dataset, query]);
  const state = dataset === 'records' ? recordsState : dictionariesState;

  const search = <Input.Search
    className="table-toolbar-search"
    allowClear
    prefix={<SearchOutlined />}
    value={input}
    onChange={(event) => setInput(event.target.value)}
    onSearch={() => setQuery(input.trim())}
    placeholder={t('personalCloud.searchAccounts')}
  />;

  return <>
    <PageHeader
      title={t('personalCloud.adminTitle')}
      description={t('personalCloud.adminDescription')}
      actions={<Button icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>}
    />
    <Alert showIcon icon={<CloudOutlined />} type="info" message={t('personalCloud.separateFromCollaboration')} style={{ marginBottom: 18 }} />
    <Tabs
      className="personal-cloud-tabs"
      activeKey={dataset}
      onChange={(value) => setDataset(value as PersonalCloudDataset)}
      items={[
        { key: 'records', label: <span><DatabaseOutlined />{t('personalCloud.recordsTab')}</span> },
        { key: 'dictionaries', label: <span><BookOutlined />{t('personalCloud.dictionariesTab')}</span> },
      ]}
    />
    {dataset === 'records' ? <Card className="surface table-card" title={search}>
      <AsyncContent loading={recordsState.loading} error={recordsState.error} empty={!recordsState.loading && !recordsState.data?.items.length} onRetry={recordsState.reload}>
        <Table<AdminPersonalSnapshotItem>
          rowKey={(row) => row.user.id}
          dataSource={recordsState.data?.items ?? []}
          scroll={{ x: 980 }}
          pagination={{
            current: page,
            pageSize,
            total: recordsState.data?.total,
            showSizeChanger: true,
            onChange: (next, size) => { setPage(next); setPageSize(size); },
          }}
          columns={[
            { title: t('personalCloud.account'), render: (_, row) => <div><Typography.Text strong>{row.user.username}</Typography.Text><br /><span className="error-code">{row.user.id}</span></div> },
            { title: t('personalCloud.sessions'), dataIndex: ['personalSnapshot', 'sessionCount'], width: 110 },
            { title: t('personalCloud.logs'), dataIndex: ['personalSnapshot', 'logCount'], width: 110 },
            { title: t('personalCloud.revision'), dataIndex: ['personalSnapshot', 'revision'], width: 100 },
            { title: t('personalCloud.updatedAt'), dataIndex: ['personalSnapshot', 'updatedAt'], width: 190, render: (value: string | null) => value ? new Date(value).toLocaleString(locale) : '—' },
            { title: t('common.actions'), width: 130, render: (_, row) => <Button type="link" icon={<EyeOutlined />} onClick={() => navigate(`/admin/sessions/accounts/${encodeURIComponent(row.user.id)}`)}>{t('admin.viewAccountSessions')}</Button> },
          ]}
        />
      </AsyncContent>
    </Card> : <Card className="surface table-card" title={search}>
      <AsyncContent loading={dictionariesState.loading} error={dictionariesState.error} empty={!dictionariesState.loading && !dictionariesState.data?.items.length} onRetry={dictionariesState.reload}>
        <Table<AdminPersonalDictionarySnapshotItem>
          rowKey={(row) => row.user.id}
          dataSource={dictionariesState.data?.items ?? []}
          scroll={{ x: 1040 }}
          pagination={{
            current: page,
            pageSize,
            total: dictionariesState.data?.total,
            showSizeChanger: true,
            onChange: (next, size) => { setPage(next); setPageSize(size); },
          }}
          columns={[
            { title: t('personalCloud.account'), render: (_, row) => <div><Typography.Text strong>{row.user.username}</Typography.Text><br /><span className="error-code">{row.user.id}</span></div> },
            { title: t('personalCloud.dictionaryItems'), dataIndex: ['personalDictionarySnapshot', 'itemCount'], width: 110 },
            { title: t('personalCloud.dictionaryActive'), dataIndex: ['personalDictionarySnapshot', 'activeCount'], width: 110 },
            { title: t('personalCloud.dictionaryDeleted'), dataIndex: ['personalDictionarySnapshot', 'deletedCount'], width: 110 },
            { title: t('personalCloud.revision'), dataIndex: ['personalDictionarySnapshot', 'revision'], width: 100 },
            { title: t('personalCloud.updatedAt'), dataIndex: ['personalDictionarySnapshot', 'updatedAt'], width: 190, render: (value: string | null) => value ? new Date(value).toLocaleString(locale) : '—' },
            { title: t('common.actions'), width: 130, render: (_, row) => <Button type="link" icon={<EyeOutlined />} onClick={() => navigate(adminPersonalSnapshotDetailRoute(row.user.id, 'dictionaries'))}>{t('common.details')}</Button> },
          ]}
        />
      </AsyncContent>
    </Card>}
  </>;
}
