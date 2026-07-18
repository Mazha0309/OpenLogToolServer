import { EyeOutlined, SearchOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Empty, Input, Space, Statistic, Table, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type { PersonalSnapshotDownload, PersonalSnapshotLog, PersonalSnapshotOwner, PersonalSnapshotSession } from '../types';
import { useI18n } from '../useI18n';
import { filterPersonalLogs, filterPersonalSessions } from '../utils/personalCloud';

function timestamp(value: string | null, locale: string): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(locale);
}
function bytes(value: number, locale: string): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1024)} KiB`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / (1024 * 1024))} MiB`;
}

function valueOrDash(value: string | null): string {
  return value || '—';
}

export function PersonalSnapshotViewer({ owner, personalSnapshot, admin }: {
  owner: PersonalSnapshotOwner;
  personalSnapshot: PersonalSnapshotDownload;
  admin: boolean;
}) {
  const { t, locale } = useI18n();
  const { snapshot } = personalSnapshot;
  const [sessionQuery, setSessionQuery] = useState('');
  const [logQuery, setLogQuery] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => snapshot.sessions[0]?.session_id ?? null);
  useEffect(() => {
    setSelectedSessionId((current) => snapshot.sessions.some((session) => session.session_id === current)
      ? current
      : snapshot.sessions[0]?.session_id ?? null);
  }, [snapshot]);
  const visibleSessions = useMemo(() => filterPersonalSessions(snapshot.sessions, sessionQuery), [snapshot.sessions, sessionQuery]);
  const visibleLogs = useMemo(() => filterPersonalLogs(snapshot.logs, selectedSessionId, logQuery), [snapshot.logs, selectedSessionId, logQuery]);
  const logCounts = useMemo(() => {
    const counts = new Map<string, number>();
    snapshot.logs.forEach((log) => counts.set(log.session_id, (counts.get(log.session_id) ?? 0) + 1));
    return counts;
  }, [snapshot.logs]);
  const selectedSession = snapshot.sessions.find((session) => session.session_id === selectedSessionId) ?? null;

  return <>
    <Alert
      showIcon
      type={admin ? 'warning' : 'info'}
      message={t(admin ? 'personalCloud.adminReadonlyTitle' : 'personalCloud.memberReadonlyTitle')}
      description={t(admin ? 'personalCloud.adminReadonlyHint' : 'personalCloud.memberReadonlyHint')}
      style={{ marginBottom: 18 }}
    />
    <div className="stat-grid">
      <Card className="surface"><Statistic title={t('personalCloud.sessions')} value={personalSnapshot.sessionCount} /></Card>
      <Card className="surface"><Statistic title={t('personalCloud.logs')} value={personalSnapshot.logCount} /></Card>
      <Card className="surface"><Statistic title={t('personalCloud.revision')} value={personalSnapshot.revision} /></Card>
      <Card className="surface"><Statistic title={t('personalCloud.size')} value={bytes(personalSnapshot.byteSize, locale)} /></Card>
    </div>
    <Card className="surface" title={t('personalCloud.snapshotMetadata')} style={{ marginBottom: 18 }}>
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, lg: 3 }} items={[
        { key: 'account', label: t('personalCloud.account'), children: <><Typography.Text strong>{owner.username}</Typography.Text><br /><span className="error-code">{owner.id}</span></> },
        { key: 'format', label: t('personalCloud.formatVersion'), children: personalSnapshot.formatVersion },
        { key: 'exported', label: t('personalCloud.exportedAt'), children: timestamp(snapshot.exportedAt, locale) },
        { key: 'created', label: t('personalCloud.createdAt'), children: timestamp(personalSnapshot.createdAt, locale) },
        { key: 'updated', label: t('personalCloud.updatedAt'), children: timestamp(personalSnapshot.updatedAt, locale) },
        { key: 'checksum', label: 'SHA-256', children: <Typography.Text className="personal-checksum" copyable>{personalSnapshot.checksum ?? '—'}</Typography.Text> },
      ]} />
    </Card>
    <Card
      className="surface table-card"
      title={<Space wrap><span>{t('personalCloud.snapshotSessions')}</span><Input allowClear prefix={<SearchOutlined />} value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder={t('personalCloud.searchSessions')} style={{ width: 280, maxWidth: '100%' }} /></Space>}
      style={{ marginBottom: 18 }}
    >
      {visibleSessions.length === 0 ? <div className="empty-state"><Empty description={t('personalCloud.noMatchingSessions')} /></div> : <Table<PersonalSnapshotSession>
        rowKey="session_id"
        dataSource={visibleSessions}
        scroll={{ x: 850 }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        rowClassName={(session) => session.session_id === selectedSessionId ? 'personal-session-selected' : ''}
        columns={[
          { title: t('sessions.session'), dataIndex: 'title', render: (value: string, row) => <div><Typography.Text strong>{value}</Typography.Text>{row.deleted_at && <Tag color="red" style={{ marginInlineStart: 8 }}>{t('personalCloud.deleted')}</Tag>}<br /><span className="error-code">{row.session_id}</span></div> },
          { title: t('common.status'), dataIndex: 'status', width: 120, render: (value: PersonalSnapshotSession['status']) => <Tag color={value === 'active' ? 'green' : value === 'archived' ? 'default' : 'blue'}>{t(`personalCloud.status.${value}`)}</Tag> },
          { title: t('personalCloud.logs'), width: 100, render: (_, row) => logCounts.get(row.session_id) ?? 0 },
          { title: t('sessions.updatedAt'), dataIndex: 'updated_at', width: 190, render: (value: string) => timestamp(value, locale) },
          { title: t('common.actions'), width: 130, render: (_, row) => <Button type={row.session_id === selectedSessionId ? 'primary' : 'link'} icon={<EyeOutlined />} onClick={() => { setSelectedSessionId(row.session_id); setLogQuery(''); }}>{t('personalCloud.viewLogs')}</Button> },
        ]}
      />}
    </Card>
    <Card
      className="surface table-card"
      title={<div className="personal-log-heading"><div><div>{t('personalCloud.logDetails')}</div>{selectedSession && <Typography.Text type="secondary">{selectedSession.title}</Typography.Text>}</div><Input allowClear prefix={<SearchOutlined />} value={logQuery} onChange={(event) => setLogQuery(event.target.value)} placeholder={t('personalCloud.searchLogs')} style={{ width: 280, maxWidth: '100%' }} /></div>}
    >
      {!selectedSession ? <div className="empty-state"><Empty description={t('personalCloud.selectSession')} /></div> : <Table<PersonalSnapshotLog>
        rowKey="sync_id"
        dataSource={visibleLogs}
        scroll={{ x: 1650 }}
        pagination={{ defaultPageSize: 50, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: (total) => t('personalCloud.logTotal', { count: total }) }}
        columns={[
          { title: t('common.time'), dataIndex: 'time', width: 180 },
          { title: t('logs.controller'), dataIndex: 'controller', width: 120 },
          { title: t('logs.callsign'), dataIndex: 'callsign', width: 120, render: (value: string, row) => <Space size={4}><Typography.Text strong>{value}</Typography.Text>{row.deleted_at && <Tag color="red">{t('personalCloud.deleted')}</Tag>}</Space> },
          { title: t('logs.rstSent'), dataIndex: 'rst_sent', width: 90, render: valueOrDash },
          { title: t('logs.rstRcvd'), dataIndex: 'rst_rcvd', width: 90, render: valueOrDash },
          { title: t('logs.qth'), dataIndex: 'qth', width: 150, render: valueOrDash },
          { title: t('logs.device'), dataIndex: 'device', width: 150, render: valueOrDash },
          { title: t('logs.power'), dataIndex: 'power', width: 100, render: valueOrDash },
          { title: t('logs.antenna'), dataIndex: 'antenna', width: 160, render: valueOrDash },
          { title: t('logs.height'), dataIndex: 'height', width: 100, render: valueOrDash },
          { title: t('logs.remarks'), dataIndex: 'remarks', width: 220, render: valueOrDash },
        ]}
      />}
    </Card>
  </>;
}
