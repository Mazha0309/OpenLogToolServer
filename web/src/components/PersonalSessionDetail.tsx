import {
  ArrowLeftOutlined,
  DownloadOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Input,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { AsyncContent } from './AsyncContent';
import { PageHeader } from './PageHeader';
import { SessionSourceTag, SessionStatusTag } from './SessionBadges';
import { ExcelExportActions } from './ExcelExportActions';
import { useAsync } from '../hooks/useAsync';
import type { LogRecord, Page, PersonalSessionDetails } from '../types';
import { useI18n } from '../useI18n';

interface PersonalSessionDetailProps {
  details: PersonalSessionDetails | null;
  loading: boolean;
  error: unknown;
  onReload: () => void;
  onBack: () => void;
  loadLogs: (params: {
    page: number;
    pageSize: number;
    q?: string;
    includeDeleted?: boolean;
    sort?: 'timeAsc' | 'timeDesc' | 'updatedDesc';
  }) => Promise<Page<LogRecord>>;
  onExport: () => Promise<void>;
  accountLabel?: ReactNode;
}

function timestamp(value: string | null, locale: string): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(locale);
}

function bytes(value: number, locale: string): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1024)} KiB`;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / (1024 * 1024))} MiB`;
}

function ReadOnlyLogs({ sessionId, loadLogs }: {
  sessionId: string;
  loadLogs: PersonalSessionDetailProps['loadLogs'];
}) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [search, setSearch] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const state = useAsync(() => loadLogs({
    page,
    pageSize,
    q: search || undefined,
    includeDeleted,
    sort: 'timeDesc',
  }), [sessionId, page, pageSize, search, includeDeleted]);
  const columns = [
    { title: t('common.time'), dataIndex: 'time', width: 178, fixed: 'left' as const, render: (value: string) => timestamp(value, locale) },
    { title: t('logs.callsign'), dataIndex: 'callsign', width: 115, fixed: 'left' as const, render: (value: string, row: LogRecord) => <Space><Typography.Text strong>{value}</Typography.Text>{row.deletedAt && <Tag color="red">{t('session.deleted')}</Tag>}</Space> },
    { title: t('logs.controller'), dataIndex: 'controller', width: 110 },
    { title: t('logs.rstSent'), dataIndex: 'rstSent', width: 88, render: (value: string | null) => value ?? '—' },
    { title: t('logs.rstRcvd'), dataIndex: 'rstRcvd', width: 88, render: (value: string | null) => value ?? '—' },
    { title: t('logs.qth'), dataIndex: 'qth', width: 150, ellipsis: true, render: (value: string | null) => value ?? '—' },
    { title: t('logs.device'), dataIndex: 'device', width: 135, ellipsis: true, render: (value: string | null) => value ?? '—' },
    { title: t('logs.power'), dataIndex: 'power', width: 90, render: (value: string | null) => value ?? '—' },
    { title: t('logs.antenna'), dataIndex: 'antenna', width: 130, ellipsis: true, render: (value: string | null) => value ?? '—' },
    { title: t('logs.height'), dataIndex: 'height', width: 90, render: (value: string | null) => value ?? '—' },
    { title: t('logs.remarks'), dataIndex: 'remarks', width: 220, ellipsis: true, render: (value: string | null) => value ?? '—' },
  ];
  return <>
    <Alert showIcon type="info" message={t('personalSession.readonlyHint')} style={{ marginBottom: 12 }} />
    <Card
      className="surface table-card"
      title={<Space className="table-toolbar" wrap>
        <Input.Search
          className="table-toolbar-search"
          allowClear
          prefix={<SearchOutlined />}
          placeholder={t('common.search')}
          onSearch={(value) => { setPage(1); setSearch(value.trim()); }}
        />
        <Checkbox checked={includeDeleted} onChange={(event) => { setPage(1); setIncludeDeleted(event.target.checked); }}>
          {t('logs.includeDeleted')}
        </Checkbox>
      </Space>}
      extra={<Button type="text" icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>}
    >
      <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.items.length} onRetry={state.reload}>
        <Table<LogRecord>
          rowKey="syncId"
          dataSource={state.data?.items ?? []}
          columns={columns}
          scroll={{ x: 1450 }}
          pagination={{
            current: page,
            pageSize,
            total: state.data?.total,
            showSizeChanger: true,
            showTotal: (total) => t('sessions.logCount', { count: total }),
            onChange: (next, size) => { setPage(next); setPageSize(size); },
          }}
          rowClassName={(row) => row.deletedAt ? 'ant-table-row-disabled' : ''}
        />
      </AsyncContent>
    </Card>
  </>;
}

export function PersonalSessionDetail(props: PersonalSessionDetailProps) {
  const { t, locale } = useI18n();
  const { message } = App.useApp();
  const [exporting, setExporting] = useState(false);
  const detail = props.details;
  const session = detail?.session;
  const exportSession = async () => {
    setExporting(true);
    try {
      await props.onExport();
      message.success(t('personalCloud.exportDatabaseV7Succeeded'));
    } catch (error) {
      message.error(t('personalCloud.exportDatabaseV7Failed', {
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setExporting(false);
    }
  };
  const tabs = detail ? [
    {
      key: 'overview',
      label: t('nav.overview'),
      children: <>
        <Alert showIcon type="info" message={t('personalSession.readonlyTitle')} description={t('personalSession.readonlyDescription')} style={{ marginBottom: 16 }} />
        <div className="stat-grid">
          <Card className="surface"><Statistic title={t('sessions.logs')} value={detail.counts.logs} /></Card>
          <Card className="surface"><Statistic title={t('admin.deletedLogs')} value={detail.counts.deletedLogs} /></Card>
          <Card className="surface"><Statistic title={t('personalCloud.revision')} value={detail.snapshot.revision} /></Card>
          <Card className="surface"><Statistic title={t('personalCloud.size')} value={bytes(detail.snapshot.byteSize, locale)} /></Card>
        </div>
        <Card className="surface">
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
            ...(props.accountLabel ? [{ key: 'account', label: t('personalCloud.account'), children: props.accountLabel }] : []),
            { key: 'id', label: 'Session ID', children: session?.sessionId },
            { key: 'created', label: t('sessions.createdAt'), children: timestamp(session?.createdAt ?? null, locale) },
            { key: 'updated', label: t('sessions.updatedAt'), children: timestamp(session?.updatedAt ?? null, locale) },
            { key: 'snapshotUpdated', label: t('personalCloud.updatedAt'), children: timestamp(detail.snapshot.updatedAt, locale) },
            { key: 'checksum', label: 'SHA-256', children: <Typography.Text copyable className="personal-checksum">{detail.snapshot.checksum}</Typography.Text> },
          ]} />
        </Card>
      </>,
    },
    {
      key: 'logs',
      label: t('sessions.logs'),
      children: <ReadOnlyLogs sessionId={detail.session.sessionId} loadLogs={props.loadLogs} />,
    },
    {
      key: 'export',
      label: t('personalSession.exportTab'),
      children: <Card className="surface" style={{ maxWidth: 760 }}>
        <Typography.Paragraph>{t('personalCloud.exportDatabaseV7Hint')}</Typography.Paragraph>
        <Button type="primary" icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportSession()}>
          {t('personalCloud.exportDatabaseV7')}
        </Button>
      </Card>,
    },
  ] : [];

  return <>
    <PageHeader
      title={session ? <span className="session-title-row">{session.title}<SessionSourceTag source="personal" /><SessionStatusTag status={session.status} /></span> : t('sessions.session')}
      description={session?.sessionId}
      actions={<Space wrap>
        {session && (
          <ExcelExportActions
            title={session.title}
            loadLogs={props.loadLogs}
          />
        )}
        <Button icon={<ReloadOutlined />} onClick={props.onReload}>{t('common.refresh')}</Button>
        <Button icon={<ArrowLeftOutlined />} onClick={props.onBack}>{t('sessions.back')}</Button>
      </Space>}
    />
    <AsyncContent loading={props.loading || (!detail && !props.error)} error={props.error} onRetry={props.onReload}>
      {detail && <Tabs className="detail-tabs" items={tabs} destroyOnHidden={false} />}
    </AsyncContent>
  </>;
}
