import { EyeOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Input, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import type { AdminSessionAccount } from '../../types';

export default function AdminSessionsPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const state = useAsync(
    () => adminApi.sessionAccounts({ page, pageSize, q: query || undefined }),
    [page, pageSize, query],
  );
  return <>
    <PageHeader title={t('admin.sessionAccountsTitle')} description={t('admin.sessionAccountsDescription')} actions={<Button icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>} />
    <Card className="surface table-card" title={<Input.Search className="table-toolbar-search" allowClear prefix={<SearchOutlined />} placeholder={t('admin.searchAccounts')} value={input} onChange={(event) => setInput(event.target.value)} onSearch={() => { setPage(1); setQuery(input.trim()); }} />}>
      <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.items.length} onRetry={state.reload}>
        <Table<AdminSessionAccount>
          rowKey={(row) => row.user.id}
          dataSource={state.data?.items ?? []}
          scroll={{ x: 1040 }}
          pagination={{ current: page, pageSize, total: state.data?.total, showSizeChanger: true, onChange: (next, size) => { setPage(next); setPageSize(size); } }}
          columns={[
            { title: t('auth.username'), dataIndex: ['user', 'username'], render: (value: string, row) => <div><Space size={4}><Typography.Text strong>{value}</Typography.Text>{row.user.deletedAt ? <Tag color="red">{t('session.deleted')}</Tag> : row.user.disabledAt ? <Tag color="orange">{t('admin.accountDisabled')}</Tag> : null}</Space><br /><span className="error-code">{row.user.id}</span></div> },
            { title: t('admin.allAccountSessions'), dataIndex: 'totalSessionCount', width: 120 },
            { title: t('sessionSource.collaboration'), dataIndex: 'collaborationSessionCount', width: 120 },
            { title: t('admin.ownedCollaborationSessions'), dataIndex: 'ownedCollaborationSessionCount', width: 130 },
            { title: t('sessionSource.personal'), dataIndex: 'personalSessionCount', width: 120 },
            { title: t('personalCloud.updatedAt'), dataIndex: 'personalSnapshotUpdatedAt', width: 190, render: (value: string | null) => value ? new Date(value).toLocaleString(locale) : '—' },
            { title: t('common.actions'), width: 120, render: (_, row) => <Button type="link" icon={<EyeOutlined />} onClick={() => navigate(`/admin/sessions/accounts/${encodeURIComponent(row.user.id)}`)}>{t('admin.viewAccountSessions')}</Button> },
          ]}
        />
      </AsyncContent>
    </Card>
  </>;
}
