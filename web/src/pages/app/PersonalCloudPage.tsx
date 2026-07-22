import { BookOutlined, DatabaseOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Statistic, Tabs } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import { accountApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { DictionarySnapshotViewer } from '../../components/DictionarySnapshotViewer';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import { hasPersonalDictionarySnapshot } from '../../utils/personalCloud';

export default function PersonalCloudPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const state = useAsync(async () => {
    const [recordsMetaResult, dictionaryMetaResult] = await Promise.all([
      accountApi.personalSnapshot(),
      accountApi.personalDictionarySnapshot(),
    ]);
    const recordsMetadata = recordsMetaResult.personalSnapshot;
    const dictionaryMetadata = dictionaryMetaResult.personalDictionarySnapshot;
    const dictionaryDownload = await (hasPersonalDictionarySnapshot(dictionaryMetadata)
        ? accountApi.downloadPersonalDictionarySnapshot().then((result) => result.personalDictionarySnapshot)
        : Promise.resolve(null));
    return { recordsMetadata, dictionaryMetadata, dictionaryDownload };
  }, []);
  const owner = { id: user?.id ?? '', username: user?.username ?? '' };

  return <>
    <PageHeader
      title={t('personalCloud.memberTitle')}
      description={t('personalCloud.memberDescription')}
      actions={<Button icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>}
    />
    <AsyncContent loading={state.loading} error={state.error} onRetry={state.reload}>
      {state.data && <Tabs
        className="personal-cloud-tabs"
        items={[
          {
            key: 'records',
            label: <span><DatabaseOutlined />{t('personalCloud.recordsTab')}</span>,
            children: <>
              <Alert showIcon type="info" message={t('personalCloud.sessionsMovedTitle')} description={t('personalCloud.sessionsMovedHint')} style={{ marginBottom: 18 }} action={<Button onClick={() => navigate('/app/sessions')}>{t('personalCloud.openSessions')}</Button>} />
              {state.data.recordsMetadata.exists ? <div className="stat-grid">
                <Card className="surface"><Statistic title={t('personalCloud.sessions')} value={state.data.recordsMetadata.sessionCount} /></Card>
                <Card className="surface"><Statistic title={t('personalCloud.logs')} value={state.data.recordsMetadata.logCount} /></Card>
                <Card className="surface"><Statistic title={t('personalCloud.revision')} value={state.data.recordsMetadata.revision} /></Card>
                <Card className="surface"><Statistic title={t('personalCloud.updatedAt')} value={state.data.recordsMetadata.updatedAt ? new Date(state.data.recordsMetadata.updatedAt).toLocaleString() : '—'} /></Card>
              </div> : <Card className="surface"><div className="empty-state"><Empty description={t('personalCloud.noSnapshot')} /></div></Card>}
            </>,
          },
          {
            key: 'dictionaries',
            label: <span><BookOutlined />{t('personalCloud.dictionariesTab')}</span>,
            children: state.data.dictionaryDownload
              ? <DictionarySnapshotViewer owner={owner} personalDictionarySnapshot={state.data.dictionaryDownload} admin={false} />
              : <><Alert showIcon type="info" message={t('personalCloud.dictionaryMemberReadonlyTitle')} description={t('personalCloud.dictionaryMemberReadonlyHint')} style={{ marginBottom: 18 }} /><Card className="surface"><div className="empty-state"><Empty description={t('personalCloud.noDictionarySnapshot')} /></div></Card></>,
          },
        ]}
      />}
    </AsyncContent>
  </>;
}
