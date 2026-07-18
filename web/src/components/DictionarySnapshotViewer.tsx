import { SearchOutlined } from '@ant-design/icons';
import {
  Alert,
  Card,
  Descriptions,
  Empty,
  Input,
  Select,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import type {
  PersonalDictionaryItemState,
  PersonalDictionarySnapshotDownload,
  PersonalDictionarySnapshotItem,
  PersonalDictionaryType,
  PersonalSnapshotOwner,
} from '../types';
import { useI18n } from '../useI18n';
import { filterPersonalDictionaryItems } from '../utils/personalCloud';

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

export function DictionarySnapshotViewer({ owner, personalDictionarySnapshot, admin }: {
  owner: PersonalSnapshotOwner;
  personalDictionarySnapshot: PersonalDictionarySnapshotDownload;
  admin: boolean;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [dictType, setDictType] = useState<PersonalDictionaryType>();
  const [state, setState] = useState<PersonalDictionaryItemState>();
  const items = useMemo(
    () => filterPersonalDictionaryItems(
      personalDictionarySnapshot.snapshot.items,
      query,
      dictType,
      state,
    ),
    [dictType, personalDictionarySnapshot.snapshot.items, query, state],
  );

  return <>
    <Alert
      showIcon
      type={admin ? 'warning' : 'info'}
      message={t(admin ? 'personalCloud.dictionaryAdminReadonlyTitle' : 'personalCloud.dictionaryMemberReadonlyTitle')}
      description={t(admin ? 'personalCloud.dictionaryAdminReadonlyHint' : 'personalCloud.dictionaryMemberReadonlyHint')}
      style={{ marginBottom: 18 }}
    />
    <div className="stat-grid">
      <Card className="surface"><Statistic title={t('personalCloud.dictionaryItems')} value={personalDictionarySnapshot.itemCount} /></Card>
      <Card className="surface"><Statistic title={t('personalCloud.dictionaryActive')} value={personalDictionarySnapshot.activeCount} /></Card>
      <Card className="surface"><Statistic title={t('personalCloud.dictionaryDeleted')} value={personalDictionarySnapshot.deletedCount} /></Card>
      <Card className="surface"><Statistic title={t('personalCloud.revision')} value={personalDictionarySnapshot.revision} /></Card>
    </div>
    <Card className="surface" title={t('personalCloud.snapshotMetadata')} style={{ marginBottom: 18 }}>
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, lg: 3 }} items={[
        { key: 'account', label: t('personalCloud.account'), children: <><Typography.Text strong>{owner.username}</Typography.Text><br /><span className="error-code">{owner.id}</span></> },
        { key: 'format', label: t('personalCloud.formatVersion'), children: personalDictionarySnapshot.formatVersion },
        { key: 'size', label: t('personalCloud.size'), children: bytes(personalDictionarySnapshot.byteSize, locale) },
        { key: 'exported', label: t('personalCloud.exportedAt'), children: timestamp(personalDictionarySnapshot.snapshot.exportedAt, locale) },
        { key: 'created', label: t('personalCloud.createdAt'), children: timestamp(personalDictionarySnapshot.createdAt, locale) },
        { key: 'updated', label: t('personalCloud.updatedAt'), children: timestamp(personalDictionarySnapshot.updatedAt, locale) },
        { key: 'checksum', label: 'SHA-256', children: <Typography.Text className="personal-checksum" copyable>{personalDictionarySnapshot.checksum ?? '—'}</Typography.Text> },
      ]} />
    </Card>
    <Card
      className="surface table-card"
      title={<div className="personal-dictionary-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('personalCloud.searchDictionaryItems')}
        />
        <Select<PersonalDictionaryType>
          allowClear
          value={dictType}
          onChange={setDictType}
          placeholder={t('personalCloud.dictionaryType')}
          options={(['device', 'antenna', 'callsign', 'qth'] as const).map((value) => ({
            value,
            label: t(`personalCloud.dictionaryType.${value}`),
          }))}
        />
        <Select<PersonalDictionaryItemState>
          allowClear
          value={state}
          onChange={setState}
          placeholder={t('common.status')}
          options={(['active', 'deleted'] as const).map((value) => ({
            value,
            label: t(`personalCloud.dictionaryState.${value}`),
          }))}
        />
      </div>}
    >
      {items.length === 0
        ? <div className="empty-state"><Empty description={t('personalCloud.noMatchingDictionaryItems')} /></div>
        : <Table<PersonalDictionarySnapshotItem>
          rowKey={(item) => `${item.dictType}\0${item.raw}`}
          dataSource={items}
          scroll={{ x: 920 }}
          pagination={{
            defaultPageSize: 50,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
            showTotal: (total) => t('personalCloud.dictionaryTotal', { count: total }),
          }}
          columns={[
            { title: t('personalCloud.dictionaryValue'), dataIndex: 'raw', render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
            { title: t('personalCloud.dictionaryType'), dataIndex: 'dictType', width: 130, render: (value: PersonalDictionaryType) => <Tag>{t(`personalCloud.dictionaryType.${value}`)}</Tag> },
            { title: t('common.status'), dataIndex: 'state', width: 120, render: (value: PersonalDictionaryItemState) => <Tag color={value === 'deleted' ? 'red' : 'green'}>{t(`personalCloud.dictionaryState.${value}`)}</Tag> },
            { title: t('personalCloud.dictionaryOrigin'), dataIndex: 'origin', width: 130, render: (value: PersonalDictionarySnapshotItem['origin']) => t(`personalCloud.dictionaryOrigin.${value}`) },
            { title: t('personalCloud.pinyin'), dataIndex: 'pinyin', width: 180, render: (value: string | null) => value || '—' },
            { title: t('personalCloud.abbreviation'), dataIndex: 'abbreviation', width: 140, render: (value: string | null) => value || '—' },
          ]}
        />}
    </Card>
  </>;
}
