import { DatabaseOutlined, SafetyCertificateOutlined, TeamOutlined, UserOutlined } from '@ant-design/icons';
import { Card, Descriptions, Progress, Statistic } from 'antd';
import { adminApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';

export default function AdminOverviewPage() {
  const { t, locale } = useI18n();
  const state = useAsync(adminApi.overview, []);
  const data = state.data;
  const sessions = data?.counts.sessions;
  return <><PageHeader title={t('admin.overview')} />
    <AsyncContent loading={state.loading} error={state.error} onRetry={state.reload}>
      {data && <>
        <div className="stat-grid">
          <Card className="surface"><Statistic title={t('admin.users')} value={data.counts.users.total} prefix={<UserOutlined />} /></Card>
          <Card className="surface"><Statistic title={t('admin.admins')} value={data.counts.users.admins} prefix={<SafetyCertificateOutlined />} /></Card>
          <Card className="surface"><Statistic title={t('admin.sessions')} value={sessions?.total} prefix={<DatabaseOutlined />} /></Card>
          <Card className="surface"><Statistic title={t('session.active')} value={sessions?.active} prefix={<TeamOutlined />} /></Card>
        </div>
        <div className="content-grid">
          <Card className="surface" title={t('admin.instance')}><Descriptions column={1} size="small" items={[
            { key: 'id', label: 'ID', children: data.serverInstanceId },
            { key: 'generated', label: t('common.time'), children: new Date(data.generatedAt).toLocaleString(locale) },
            { key: 'register', label: t('settings.registration'), children: data.registrationEnabled ? t('common.yes') : t('common.no') },
          ]} /></Card>
          <Card className="surface" title={t('admin.sessions')}>
            <Progress percent={sessions?.total ? Math.round((sessions.active / sessions.total) * 100) : 0} format={() => `${sessions?.active ?? 0} ${t('session.active')}`} />
            <Descriptions column={2} size="small" style={{ marginTop: 18 }} items={[
              { key: 'initializing', label: t('session.initializing'), children: sessions?.initializing },
              { key: 'closed', label: t('session.closed'), children: sessions?.closed },
              { key: 'deleted', label: t('session.deleted'), children: sessions?.deleted },
              { key: 'total', label: t('admin.sessions'), children: sessions?.total },
            ]} />
          </Card>
        </div>
      </>}
    </AsyncContent>
  </>;
}
