import { BookOutlined, DatabaseOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Tabs } from 'antd';
import { useAuth } from '../../AuthContext';
import { accountApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { DictionarySnapshotViewer } from '../../components/DictionarySnapshotViewer';
import { PageHeader } from '../../components/PageHeader';
import { PersonalSnapshotViewer } from '../../components/PersonalSnapshotViewer';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import { hasPersonalDictionarySnapshot, hasPersonalSnapshot } from '../../utils/personalCloud';

export default function PersonalCloudPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const state = useAsync(async () => {
    const [recordsMetaResult, dictionaryMetaResult] = await Promise.all([
      accountApi.personalSnapshot(),
      accountApi.personalDictionarySnapshot(),
    ]);
    const recordsMetadata = recordsMetaResult.personalSnapshot;
    const dictionaryMetadata = dictionaryMetaResult.personalDictionarySnapshot;
    const [recordsDownload, dictionaryDownload] = await Promise.all([
      hasPersonalSnapshot(recordsMetadata)
        ? accountApi.downloadPersonalSnapshot().then((result) => result.personalSnapshot)
        : Promise.resolve(null),
      hasPersonalDictionarySnapshot(dictionaryMetadata)
        ? accountApi.downloadPersonalDictionarySnapshot().then((result) => result.personalDictionarySnapshot)
        : Promise.resolve(null),
    ]);
    return { recordsMetadata, dictionaryMetadata, recordsDownload, dictionaryDownload };
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
            children: state.data.recordsDownload
              ? <PersonalSnapshotViewer
                  owner={owner}
                  personalSnapshot={state.data.recordsDownload}
                  admin={false}
                  onExportDatabaseV7={accountApi.exportPersonalSnapshotDatabaseV7}
                />
              : <><Alert showIcon type="info" message={t('personalCloud.memberReadonlyTitle')} description={t('personalCloud.memberReadonlyHint')} style={{ marginBottom: 18 }} /><Card className="surface"><div className="empty-state"><Empty description={t('personalCloud.noSnapshot')} /></div></Card></>,
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
