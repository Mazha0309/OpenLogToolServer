import {
  ArrowLeftOutlined,
  EyeOutlined,
  LinkOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { adminApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { SessionStatusTag } from '../../components/SessionBadges';
import { useAsync } from '../../hooks/useAsync';
import type { PublicLiveshareState, PublicLiveshareVisitor } from '../../types';
import { useI18n } from '../../useI18n';

function finite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function formatOpenCount(value: number, saturated: boolean, locale: string): string {
  return `${finite(value).toLocaleString(locale)}${saturated ? '+' : ''}`;
}

function formatTimestamp(value: string | null, locale: string, fallback: string): string {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString(locale) : fallback;
}

function stateColor(state: PublicLiveshareState): string {
  if (state === 'active') return 'green';
  if (state === 'expired') return 'orange';
  if (state === 'revoked') return 'red';
  return 'magenta';
}

export default function PublicLiveshareDetailPage() {
  const { publicShareId = '' } = useParams();
  const navigate = useNavigate();
  const { t, locale } = useI18n();
  const detail = useAsync(
    () => adminApi.publicLiveshareStat(publicShareId),
    [publicShareId],
  );
  const reloadDetail = detail.reload;
  const refreshInFlight = useRef(true);
  const refresh = useCallback(() => {
    if (detail.loading || refreshInFlight.current) return;
    refreshInFlight.current = true;
    reloadDetail();
  }, [detail.loading, reloadDetail]);

  useEffect(() => {
    if (!detail.loading) refreshInFlight.current = false;
  }, [detail.loading]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };
    const timer = window.setInterval(refreshWhenVisible, 10_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refresh]);

  const response = detail.data;
  const item = response?.item;
  const never = t('admin.neverOpened');
  const stateLabel = (state: PublicLiveshareState) => {
    if (state === 'active') return t('admin.liveShareState.active');
    if (state === 'expired') return t('admin.liveShareState.expired');
    if (state === 'revoked') return t('admin.liveShareState.revoked');
    return t('admin.liveShareState.sessionDeleted');
  };

  return <>
    <PageHeader
      title={<span className="session-title-row">
        {item?.sessionTitle ?? t('admin.liveShareDetailTitle')}
        {item && <Tag color={stateColor(item.state)}>{stateLabel(item.state)}</Tag>}
      </span>}
      description={<div>
        <div>{t('admin.liveShareDetailDescription')}</div>
        {response && <div className="operations-updated-at">
          {t('admin.metricsUpdatedAt', { time: formatTimestamp(response.generatedAt, locale, '—') })}
        </div>}
      </div>}
      actions={<>
        <Button icon={<ReloadOutlined />} loading={detail.loading} onClick={refresh}>{t('common.refresh')}</Button>
        {item && <Button
          icon={<LinkOutlined />}
          onClick={() => navigate(`/admin/sessions/${encodeURIComponent(item.sessionId)}`)}
        >{t('admin.openCollaborationSession')}</Button>}
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/admin/operations')}>{t('admin.backToOperations')}</Button>
      </>}
    />

    {detail.error && response && <Alert
      showIcon
      type="warning"
      message={t('admin.metricsRefreshFailed')}
      style={{ marginBottom: 16 }}
    />}

    <AsyncContent
      loading={detail.loading && !response}
      error={response ? null : detail.error}
      onRetry={refresh}
    >
      {item && response && <>
        <Alert
          showIcon
          type="info"
          message={t('admin.liveShareDetailCountingHint')}
          description={response.scope.trackingStartedAt
            ? t('admin.openTrackingStartedAt', {
                time: formatTimestamp(response.scope.trackingStartedAt, locale, '—'),
              })
            : undefined}
          style={{ marginBottom: 18 }}
        />

        {item.openCountSaturated && <Alert
          showIcon
          type="warning"
          message={t('admin.liveShareOpenCountSaturated')}
          description={item.openCountSaturatedAt
            ? t('admin.openCountSaturatedAt', {
                time: formatTimestamp(item.openCountSaturatedAt, locale, '—'),
              })
            : undefined}
          style={{ marginBottom: 18 }}
        />}

        <div className="stat-grid liveshare-detail-stat-grid">
          <Card className="surface"><Statistic
            title={t('admin.currentViewConnections')}
            value={finite(item.currentConnections)}
            prefix={<EyeOutlined />}
          /><div className="metric-card-note">{t('admin.currentConnectionsScope')}</div></Card>
          <Card className="surface"><Statistic
            title={t('admin.totalValidOpens')}
            value={formatOpenCount(item.totalOpens, item.openCountSaturated, locale)}
            prefix={<LinkOutlined />}
          /><div className="metric-card-note">{item.openCountSaturated
              ? t('admin.openCountIsLowerBound')
              : t('admin.anonymousPageSessions')}
          </div></Card>
          <Card className="surface liveshare-status-card">
            <Typography.Text type="secondary">{t('admin.shareState')}</Typography.Text>
            <div className="liveshare-status-value"><Tag color={stateColor(item.state)}>{stateLabel(item.state)}</Tag></div>
            <div className="metric-card-note">{t('admin.collaborationSessionStatus')}: <SessionStatusTag status={item.sessionStatus} /></div>
          </Card>
        </div>

        <Card
          className="surface table-card liveshare-visitor-table"
          title={t('admin.liveShareVisitors')}
          extra={item.currentConnections > 0
            ? <Tag color="success" icon={<EyeOutlined />}>{t('admin.visitorsCurrentlyViewing', {
                count: finite(item.currentConnections),
              })}</Tag>
            : <Typography.Text type="secondary">{t('admin.noCurrentVisitors')}</Typography.Text>}
        >
          <Table<PublicLiveshareVisitor>
            rowKey={(visitor, index) => [
              visitor.ipAddress ?? 'unknown',
              index ?? 0,
            ].join(':')}
            size="small"
            pagination={false}
            dataSource={response.visitors}
            locale={{ emptyText: t('admin.noVisitorRecords') }}
            rowClassName={(visitor) => visitor.currentConnections > 0
              ? 'liveshare-active-visitor-row'
              : ''}
            scroll={{ x: 1_060 }}
            columns={[
              {
                title: t('admin.visitorStatus'),
                dataIndex: 'currentConnections',
                width: 170,
                render: (value: number) => value > 0
                  ? <Tag color="success" icon={<EyeOutlined />}>{t('admin.visitorViewingNow', {
                      count: finite(value),
                    })}</Tag>
                  : <Typography.Text type="secondary">{t('admin.visitorDisconnected')}</Typography.Text>,
              },
              {
                title: t('admin.visitorIpAddress'),
                dataIndex: 'ipAddress',
                width: 190,
                render: (value: string | null) => value
                  ? <Typography.Text className="identifier-value" copyable>{value}</Typography.Text>
                  : <Typography.Text type="secondary">—</Typography.Text>,
              },
              {
                title: t('admin.visitorLocation'),
                dataIndex: 'location',
                width: 230,
                render: (value: PublicLiveshareVisitor['location']) => value
                  ? <Typography.Text>{value.displayName}</Typography.Text>
                  : <Typography.Text type="secondary">{t('admin.visitorLocationUnavailable')}</Typography.Text>,
              },
              {
                title: t('admin.visitorVisitCount'),
                dataIndex: 'visitCount',
                width: 110,
                align: 'right',
                render: (value: number) => finite(value).toLocaleString(locale),
              },
              {
                title: t('admin.visitorFirstSeenAt'),
                dataIndex: 'firstSeenAt',
                width: 190,
                render: (value: string | null) => formatTimestamp(value, locale, '—'),
              },
              {
                title: t('admin.visitorLastSeenAt'),
                dataIndex: 'lastSeenAt',
                width: 190,
                render: (value: string | null) => formatTimestamp(value, locale, '—'),
              },
            ]}
          />
          <div className="metric-card-note liveshare-visitor-hint">
            {t('admin.visitorIpTrustProxyHint', { count: response.scope.visitorDetailLimit })}
          </div>
        </Card>

        <div className="content-grid liveshare-detail-grid">
          <Card className="surface" title={t('admin.liveShareIdentity')}>
            <Descriptions size="small" column={1} items={[
              {
                key: 'title',
                label: t('admin.sessionTitle'),
                children: item.sessionTitle,
              },
              {
                key: 'session-id',
                label: t('admin.sessionIdentifier'),
                children: <Link to={`/admin/sessions/${encodeURIComponent(item.sessionId)}`} className="identifier-value">{item.sessionId}</Link>,
              },
              {
                key: 'share-id',
                label: t('admin.shareIdentifier'),
                children: <Typography.Text className="identifier-value" copyable>{item.publicShareId}</Typography.Text>,
              },
              {
                key: 'share-state',
                label: t('admin.shareState'),
                children: <Tag color={stateColor(item.state)}>{stateLabel(item.state)}</Tag>,
              },
              {
                key: 'session-state',
                label: t('admin.collaborationSessionStatus'),
                children: <SessionStatusTag status={item.sessionStatus} />,
              },
            ]} />
          </Card>

          <Card className="surface" title={t('admin.liveShareTimeline')}>
            <Descriptions size="small" column={1} items={[
              { key: 'created', label: t('admin.shareCreatedAt'), children: formatTimestamp(item.createdAt, locale, '—') },
              { key: 'expires', label: t('invites.expires'), children: formatTimestamp(item.expiresAt, locale, '—') },
              { key: 'revoked', label: t('admin.shareRevokedAt'), children: formatTimestamp(item.revokedAt, locale, t('admin.notRevoked')) },
              { key: 'first-opened', label: t('admin.firstOpenedAt'), children: formatTimestamp(item.firstOpenedAt, locale, never) },
              { key: 'last-opened', label: t('admin.lastOpenedAt'), children: formatTimestamp(item.lastOpenedAt, locale, never) },
              { key: 'last-accessed', label: t('admin.lastAccessedAt'), children: formatTimestamp(item.lastAccessedAt, locale, never) },
            ]} />
          </Card>
        </div>
      </>}
    </AsyncContent>
  </>;
}
