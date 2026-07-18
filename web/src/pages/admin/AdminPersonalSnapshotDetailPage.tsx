import {
  ArrowLeftOutlined,
  BookOutlined,
  DatabaseOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { Button, Tabs } from 'antd';
import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { adminApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { DictionarySnapshotViewer } from '../../components/DictionarySnapshotViewer';
import { PageHeader } from '../../components/PageHeader';
import { PersonalSnapshotViewer } from '../../components/PersonalSnapshotViewer';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import {
  ADMIN_PERSONAL_SNAPSHOTS_ROUTE,
  type PersonalCloudDataset,
} from '../../utils/personalCloud';

export default function AdminPersonalSnapshotDetailPage() {
  const { userId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const dataset: PersonalCloudDataset = searchParams.get('dataset') === 'dictionaries'
    ? 'dictionaries'
    : 'records';
  // One audited access ID is reused while this account and dataset remain mounted.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const accessId = useMemo(() => crypto.randomUUID(), [dataset, userId]);
  const { t } = useI18n();
  const navigate = useNavigate();
  const recordsState = useAsync(
    () => dataset === 'records' ? adminApi.personalSnapshot(userId, accessId) : Promise.resolve(null),
    [accessId, dataset, userId],
  );
  const dictionariesState = useAsync(
    () => dataset === 'dictionaries' ? adminApi.personalDictionarySnapshot(userId, accessId) : Promise.resolve(null),
    [accessId, dataset, userId],
  );
  const state = dataset === 'records' ? recordsState : dictionariesState;
  const owner = recordsState.data?.user ?? dictionariesState.data?.user;

  return <>
    <PageHeader
      title={owner?.username ?? t('personalCloud.adminDetailTitle')}
      description={owner ? `${t('personalCloud.accountSnapshot')} · ${owner.id}` : t('personalCloud.accountSnapshot')}
      actions={<>
        <Button icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ADMIN_PERSONAL_SNAPSHOTS_ROUTE)}>{t('personalCloud.backToAccounts')}</Button>
      </>}
    />
    <Tabs
      className="personal-cloud-tabs"
      activeKey={dataset}
      onChange={(value) => setSearchParams(value === 'dictionaries' ? { dataset: value } : {})}
      items={[
        { key: 'records', label: <span><DatabaseOutlined />{t('personalCloud.recordsTab')}</span> },
        { key: 'dictionaries', label: <span><BookOutlined />{t('personalCloud.dictionariesTab')}</span> },
      ]}
    />
    {dataset === 'records' ? <AsyncContent loading={recordsState.loading} error={recordsState.error} onRetry={recordsState.reload}>
      {recordsState.data && <PersonalSnapshotViewer owner={recordsState.data.user} personalSnapshot={recordsState.data.personalSnapshot} admin />}
    </AsyncContent> : <AsyncContent loading={dictionariesState.loading} error={dictionariesState.error} onRetry={dictionariesState.reload}>
      {dictionariesState.data && <DictionarySnapshotViewer owner={dictionariesState.data.user} personalDictionarySnapshot={dictionariesState.data.personalDictionarySnapshot} admin />}
    </AsyncContent>}
  </>;
}
