import { EyeOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Checkbox, Input, Select, Space, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi, type AdminSession } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { SessionStatusTag } from '../../components/SessionBadges';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';

export default function AdminSessionsPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const state = useAsync(() => adminApi.sessions({ page, pageSize, q: query || undefined, status, includeDeleted }), [page, pageSize, query, status, includeDeleted]);
  useEffect(() => setPage(1), [query, status, includeDeleted]);
  return <><PageHeader title={t('admin.sessionsGovernance')} actions={<Button icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>} />
    <Card className="surface table-card" title={<Space className="table-toolbar" wrap><Input.Search className="table-toolbar-search" allowClear prefix={<SearchOutlined />} value={input} onChange={(event) => setInput(event.target.value)} onSearch={() => setQuery(input.trim())} placeholder={t('common.search')} /><Select allowClear placeholder={t('common.status')} value={status} onChange={setStatus} style={{ width: 150 }} options={(['initializing', 'active', 'closed'] as const).map((value) => ({ value, label: t(`session.${value}`) }))} /><Checkbox checked={includeDeleted} onChange={(event) => setIncludeDeleted(event.target.checked)}>{t('logs.includeDeleted')}</Checkbox></Space>}>
      <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.items.length} onRetry={state.reload}>
        <Table<AdminSession> rowKey="sessionId" dataSource={state.data?.items ?? []} scroll={{ x: 920 }} pagination={{ current: page, pageSize, total: state.data?.total, showSizeChanger: true, onChange: (next, size) => { setPage(next); setPageSize(size); } }} columns={[
          { title: t('sessions.session'), dataIndex: 'title', render: (value: string, row) => <div><Typography.Text strong>{value}</Typography.Text><br /><span className="error-code">{row.sessionId}</span></div> },
          { title: t('common.status'), dataIndex: 'status', width: 120, render: (value: string, row) => <SessionStatusTag status={row.deletedAt ? 'deleted' : value} /> },
          { title: t('admin.owner'), dataIndex: 'ownerUsername', width: 160, render: (value: string | undefined, row: AdminSession) => value ?? row.ownerUserId ?? '—' },
          { title: t('sessions.updatedAt'), dataIndex: 'updatedAt', width: 190, render: (value: string) => new Date(value).toLocaleString(locale) },
          { title: t('common.actions'), width: 120, render: (_, row) => <Button type="link" icon={<EyeOutlined />} onClick={() => navigate(`/admin/sessions/${encodeURIComponent(row.sessionId)}`)}>{t('common.details')}</Button> },
        ]} />
      </AsyncContent>
    </Card>
  </>;
}
