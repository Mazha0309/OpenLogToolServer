import { ArrowRightOutlined, CrownOutlined, DatabaseOutlined, EditOutlined } from '@ant-design/icons';
import { Button, Card, List, Statistic } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import { sessionsApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { SessionRoleTag, SessionStatusTag } from '../../components/SessionBadges';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';

export default function OverviewPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const state = useAsync(sessionsApi.list, []);
  const sessions = state.data ?? [];
  return (
    <>
      <PageHeader title={t('overview.welcome', { name: user?.username ?? '' })} description={t('overview.description')} />
      <div className="stat-grid">
        <Card className="surface"><Statistic title={t('overview.sessionCount')} value={sessions.length} prefix={<DatabaseOutlined />} /></Card>
        <Card className="surface"><Statistic title={t('overview.ownedCount')} value={sessions.filter((item) => item.role === 'owner').length} prefix={<CrownOutlined />} /></Card>
        <Card className="surface"><Statistic title={t('overview.editableCount')} value={sessions.filter((item) => item.role !== 'viewer').length} prefix={<EditOutlined />} /></Card>
        <Card className="surface"><Statistic title={t('session.active')} value={sessions.filter((item) => item.status === 'active').length} /></Card>
      </div>
      <Card className="surface" title={t('overview.recent')} extra={<Button type="link" onClick={() => navigate('/app/sessions')}>{t('nav.sessions')} <ArrowRightOutlined /></Button>}>
        <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && sessions.length === 0} onRetry={state.reload}>
          <List dataSource={sessions.slice(0, 6)} renderItem={(item) => <List.Item actions={[<Button key="open" type="text" icon={<ArrowRightOutlined />} onClick={() => navigate(`/app/sessions/${encodeURIComponent(item.sessionId)}`)} />]}>
            <List.Item.Meta title={<span className="session-title-row">{item.title}<SessionStatusTag status={item.status} /><SessionRoleTag role={item.role} /></span>} description={new Date(item.updatedAt).toLocaleString()} />
          </List.Item>} />
        </AsyncContent>
      </Card>
    </>
  );
}
