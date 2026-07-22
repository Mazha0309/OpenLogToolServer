import { EyeOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Input, Table, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionsApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { SessionRoleTag, SessionStatusTag } from '../../components/SessionBadges';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import type { SessionSummary } from '../../types';

export default function SessionsPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const state = useAsync(() => sessionsApi.catalog({ page, pageSize, q: query || undefined }), [page, pageSize, query]);
  const items = state.data?.items ?? [];
  const columns = [
    { title: t('sessions.session'), dataIndex: 'title', key: 'title', render: (value: string, row: SessionSummary) => <div><Typography.Text strong>{value}</Typography.Text><br /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.sessionId}</Typography.Text></div> },
    { title: t('common.status'), dataIndex: 'status', width: 120, render: (value: SessionSummary['status']) => <SessionStatusTag status={value} /> },
    { title: t('common.role'), dataIndex: 'role', width: 120, render: (value: SessionSummary['role']) => <SessionRoleTag role={value} /> },
    { title: t('sessions.updatedAt'), dataIndex: 'updatedAt', width: 190, render: (value: string) => new Date(value).toLocaleString(locale) },
    { title: t('common.actions'), key: 'actions', width: 100, render: (_: unknown, row: SessionSummary) => <Button type="link" icon={<EyeOutlined />} onClick={() => navigate(`/app/sessions/${encodeURIComponent(row.sessionId)}`)}>{t('common.details')}</Button> },
  ];
  return (
    <>
      <PageHeader title={t('sessions.title')} description={t('sessions.description')} actions={<Button icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>} />
      <Card className="surface table-card" title={<Input.Search className="table-toolbar-search" allowClear prefix={<SearchOutlined />} placeholder={t('common.search')} value={input} onChange={(event) => setInput(event.target.value)} onSearch={() => { setPage(1); setQuery(input.trim()); }} />}>
        <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && items.length === 0} onRetry={state.reload}>
          <Table<SessionSummary> rowKey="sessionId" columns={columns} dataSource={items} pagination={{ current: page, pageSize, total: state.data?.total, showSizeChanger: true, onChange: (next, size) => { setPage(next); setPageSize(size); } }} scroll={{ x: 850 }} />
        </AsyncContent>
      </Card>
    </>
  );
}
