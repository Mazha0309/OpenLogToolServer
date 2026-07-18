import { describe, expect, it } from 'vitest';
import type {
  PersonalDictionarySnapshotItem,
  PersonalDictionarySnapshotMetadata,
  PersonalSnapshotLog,
  PersonalSnapshotMetadata,
  PersonalSnapshotSession,
} from '../types';
import {
  ADMIN_PERSONAL_SNAPSHOTS_ROUTE,
  MEMBER_PERSONAL_CLOUD_ROUTE,
  adminPersonalSnapshotDetailRoute,
  filterPersonalDictionaryItems,
  filterPersonalLogs,
  filterPersonalSessions,
  hasPersonalSnapshot,
  hasPersonalDictionarySnapshot,
} from './personalCloud';

const metadata: PersonalSnapshotMetadata = {
  exists: false,
  revision: 0,
  formatVersion: 1,
  sessionCount: 0,
  logCount: 0,
  byteSize: 0,
  checksum: null,
  createdAt: null,
  updatedAt: null,
};

const dictionaryMetadata: PersonalDictionarySnapshotMetadata = {
  exists: false,
  revision: 0,
  formatVersion: 1,
  itemCount: 0,
  activeCount: 0,
  deletedCount: 0,
  byteSize: 0,
  checksum: null,
  createdAt: null,
  updatedAt: null,
};

const dictionaryItems: PersonalDictionarySnapshotItem[] = [
  { dictType: 'callsign', raw: 'BG5CRL', origin: 'user', state: 'active', pinyin: null, abbreviation: null },
  { dictType: 'qth', raw: '浙江杭州', origin: 'user', state: 'active', pinyin: 'zhe jiang hang zhou', abbreviation: 'zjhz' },
  { dictType: 'antenna', raw: '八木天线', origin: 'builtin', state: 'deleted', pinyin: null, abbreviation: null },
];

const sessions: PersonalSnapshotSession[] = [
  { session_id: 'session-1', title: 'Friday Net', status: 'closed', created_at: '2026-07-18T12:00:00Z', updated_at: '2026-07-18T13:00:00Z', closed_at: '2026-07-18T13:00:00Z', deleted_at: null },
  { session_id: 'session-2', title: '周末点名', status: 'active', created_at: '2026-07-19T12:00:00Z', updated_at: '2026-07-19T12:00:00Z', closed_at: null, deleted_at: null },
];

const logs: PersonalSnapshotLog[] = [
  { sync_id: 'log-1', session_id: 'session-1', time: '20:01', controller: 'BG5AAA', callsign: 'BG5BBB', rst_sent: '59', rst_rcvd: '59', qth: 'Hangzhou', device: null, power: null, antenna: null, height: null, remarks: null, created_at: '2026-07-18T12:01:00Z', updated_at: '2026-07-18T12:01:00Z', deleted_at: null, source_device_id: null },
  { sync_id: 'log-2', session_id: 'session-2', time: '20:02', controller: 'BG5CCC', callsign: 'BG5DDD', rst_sent: null, rst_rcvd: null, qth: 'Ningbo', device: null, power: null, antenna: null, height: null, remarks: 'mobile', created_at: '2026-07-19T12:02:00Z', updated_at: '2026-07-19T12:02:00Z', deleted_at: '2026-07-19T12:03:00Z', source_device_id: null },
];

describe('personal cloud routes and view model', () => {
  it('keeps member, administrator list, and escaped detail routes distinct', () => {
    expect(MEMBER_PERSONAL_CLOUD_ROUTE).toBe('/app/personal-cloud');
    expect(ADMIN_PERSONAL_SNAPSHOTS_ROUTE).toBe('/admin/personal-snapshots');
    expect(adminPersonalSnapshotDetailRoute('user/a b')).toBe('/admin/personal-snapshots/user%2Fa%20b');
    expect(adminPersonalSnapshotDetailRoute('user/a b', 'dictionaries')).toBe('/admin/personal-snapshots/user%2Fa%20b?dataset=dictionaries');
  });

  it('recognizes the important no-snapshot empty state', () => {
    expect(hasPersonalSnapshot(metadata)).toBe(false);
    expect(hasPersonalSnapshot({ ...metadata, exists: true, revision: 1 })).toBe(true);
    expect(hasPersonalDictionarySnapshot(dictionaryMetadata)).toBe(false);
    expect(hasPersonalDictionarySnapshot({ ...dictionaryMetadata, exists: true, revision: 1 })).toBe(true);
  });

  it('searches sessions and keeps log filtering scoped to the selected session', () => {
    expect(filterPersonalSessions(sessions, '周末')).toEqual([sessions[1]]);
    expect(filterPersonalSessions(sessions, 'SESSION-1')).toEqual([sessions[0]]);
    expect(filterPersonalLogs(logs, 'session-1', 'hangzhou')).toEqual([logs[0]]);
    expect(filterPersonalLogs(logs, 'session-1', 'mobile')).toEqual([]);
    expect(filterPersonalLogs(logs, null, 'mobile')).toEqual([logs[1]]);
  });

  it('filters dictionary changes by query, type, and state', () => {
    expect(filterPersonalDictionaryItems(dictionaryItems, 'zjhz')).toEqual([dictionaryItems[1]]);
    expect(filterPersonalDictionaryItems(dictionaryItems, '', 'callsign')).toEqual([dictionaryItems[0]]);
    expect(filterPersonalDictionaryItems(dictionaryItems, '', undefined, 'deleted')).toEqual([dictionaryItems[2]]);
  });
});
