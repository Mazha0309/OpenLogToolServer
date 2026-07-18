import type {
  PersonalDictionarySnapshotItem,
  PersonalDictionarySnapshotMetadata,
  PersonalDictionaryType,
  PersonalSnapshotLog,
  PersonalSnapshotMetadata,
  PersonalSnapshotSession,
} from '../types';

export const MEMBER_PERSONAL_CLOUD_ROUTE = '/app/personal-cloud';
export const ADMIN_PERSONAL_SNAPSHOTS_ROUTE = '/admin/personal-snapshots';

export type PersonalCloudDataset = 'records' | 'dictionaries';

export function adminPersonalSnapshotDetailRoute(
  userId: string,
  dataset: PersonalCloudDataset = 'records',
): string {
  const route = `${ADMIN_PERSONAL_SNAPSHOTS_ROUTE}/${encodeURIComponent(userId)}`;
  return dataset === 'dictionaries' ? `${route}?dataset=dictionaries` : route;
}

export function hasPersonalSnapshot(metadata: PersonalSnapshotMetadata): boolean {
  return metadata.exists;
}

export function hasPersonalDictionarySnapshot(
  metadata: PersonalDictionarySnapshotMetadata,
): boolean {
  return metadata.exists;
}

export function filterPersonalSessions(sessions: PersonalSnapshotSession[], query: string): PersonalSnapshotSession[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) => `${session.title}\n${session.session_id}`.toLocaleLowerCase().includes(needle));
}

export function filterPersonalLogs(logs: PersonalSnapshotLog[], sessionId: string | null, query: string): PersonalSnapshotLog[] {
  const needle = query.trim().toLocaleLowerCase();
  return logs.filter((log) => {
    if (sessionId && log.session_id !== sessionId) return false;
    if (!needle) return true;
    return [
      log.controller,
      log.callsign,
      log.rst_sent,
      log.rst_rcvd,
      log.qth,
      log.device,
      log.power,
      log.antenna,
      log.height,
      log.remarks,
      log.time,
    ].some((value) => value?.toLocaleLowerCase().includes(needle));
  });
}

export function filterPersonalDictionaryItems(
  items: PersonalDictionarySnapshotItem[],
  query: string,
  dictType?: PersonalDictionaryType,
  state?: 'active' | 'deleted',
): PersonalDictionarySnapshotItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (dictType && item.dictType !== dictType) return false;
    if (state && item.state !== state) return false;
    if (!needle) return true;
    return [item.raw, item.pinyin, item.abbreviation]
      .some((value) => value?.toLocaleLowerCase().includes(needle));
  });
}
