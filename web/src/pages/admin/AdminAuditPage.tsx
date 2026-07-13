import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Input, Table, Tag } from 'antd';
import { useState } from 'react';
import { adminApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import type { AuditEvent } from '../../types';

export default function AdminAuditPage() {
  const { t, locale } = useI18n();
  const [input, setInput] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const state = useAsync(() => adminApi.audit({ page, pageSize, action: action || undefined }), [page, pageSize, action]);
  return <><PageHeader title={t('admin.audit')} actions={<Button icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>} />
    <Card className="surface table-card" title={<Input.Search allowClear prefix={<SearchOutlined />} placeholder={t('audit.action')} value={input} onChange={(event) => setInput(event.target.value)} onSearch={() => setAction(input.trim())} style={{ maxWidth: 360 }} />}>
      <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.items.length} onRetry={state.reload}>
        <Table<AuditEvent> rowKey="auditEventId" dataSource={state.data?.items ?? []} pagination={{ current: page, pageSize, total: state.data?.total, showSizeChanger: true, onChange: (next, size) => { setPage(next); setPageSize(size); } }} scroll={{ x: 1050 }} expandable={{ expandedRowRender: (row) => <pre className="json-preview">{JSON.stringify({ before: row.before, after: row.after, details: row.details, reason: row.reason, requestId: row.requestId, mutationId: row.mutationId }, null, 2)}</pre> }} columns={[
          { title: t('common.time'), dataIndex: 'occurredAt', width: 190, render: (value: string) => new Date(value).toLocaleString(locale) },
          { title: t('audit.action'), dataIndex: 'action', width: 260, render: (value: string) => <Tag>{value}</Tag> },
          { title: t('audit.actor'), dataIndex: 'actorUserId', ellipsis: true },
          { title: t('audit.target'), dataIndex: 'targetId', ellipsis: true, render: (value: string | null, row) => value ?? row.sessionId ?? '—' },
        ]} />
      </AsyncContent>
    </Card>
  </>;
}
