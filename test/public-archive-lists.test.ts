import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';
import { validatePersonalSnapshot } from '../src/personal-snapshot/model';
import {
  normalizePublicArchiveAlias,
  publicArchiveListDto,
  publicArchiveLogDto,
  publicArchiveSessionDto,
} from '../src/public-archives/model';
import {
  addArchiveMember,
  addArchiveSource,
  createArchiveList,
  createArchiveSnapshot,
  getArchiveList,
  listArchiveCandidateAccounts,
  listArchiveLists,
  listAvailableArchiveSessions,
  publishArchiveList,
  refreshArchiveSnapshot,
  removeArchiveSession,
  reorderArchiveSessions,
  softDeleteArchiveList,
  unpublishArchiveList,
} from '../src/public-archives/service';

const now = '2026-08-18T00:00:00.000Z';

function archiveFixture(db: ReturnType<typeof openDatabase>) {
  const user = db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
    VALUES (?, ?, 'hash', ?, ?, ?)`);
  user.run('owner', 'owner', 'user', now, now);
  user.run('member', 'member', 'user', now, now);
  user.run('other', 'other', 'user', now, now);
  user.run('admin', 'admin', 'admin', now, now);
  const session = db.prepare(`INSERT INTO sessions
    (id, title, status, owner_user_id, version, event_seq, min_retained_seq, created_at, updated_at, closed_at, deleted_at)
    VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?)`);
  session.run('closed', 'Closed collaboration', 'closed', 'owner', now, now, now, null);
  session.run('active', 'Active collaboration', 'active', 'owner', now, now, null, null);
  session.run('deleted', 'Deleted collaboration', 'closed', 'owner', now, now, now, now);
  const membership = db.prepare(`INSERT INTO session_members
    (id, session_id, user_id, role, version, created_at, updated_at) VALUES (?, ?, ?, 'owner', 1, ?, ?)`);
  membership.run('membership-owner-closed', 'closed', 'owner', now, now);
  membership.run('membership-owner-active', 'active', 'owner', now, now);
  membership.run('membership-owner-deleted', 'deleted', 'owner', now, now);
  db.prepare(`INSERT INTO logs (sync_id, session_id, controller, callsign, time, remarks, created_at, updated_at, deleted_at)
    VALUES ('log-b', 'closed', 'BR5AI', 'BG5BBB', '11:00', 'before', ?, ?, NULL)`).run(now, now);
  db.prepare(`INSERT INTO logs (sync_id, session_id, controller, callsign, time, remarks, created_at, updated_at, deleted_at)
    VALUES ('log-a', 'closed', 'BR5AI', 'BG5AAA', '11:00', 'before', ?, ?, NULL)`).run(now, now);
  db.prepare(`INSERT INTO sessions
    (id, title, status, owner_user_id, version, event_seq, min_retained_seq, created_at, updated_at, closed_at)
    VALUES ('other-closed', 'Other closed collaboration', 'closed', 'other', 1, 0, 0, ?, ?, ?)`).run(now, now, now);
  db.prepare(`INSERT INTO session_members (id, session_id, user_id, role, version, created_at, updated_at)
    VALUES ('membership-other-closed', 'other-closed', 'other', 'owner', 1, ?, ?)`).run(now, now);
  return { owner: { userId: 'owner', role: 'user' as const }, member: { userId: 'member', role: 'user' as const }, other: { userId: 'other', role: 'user' as const }, admin: { userId: 'admin', role: 'admin' as const } };
}

test('archive service enforces management boundaries and preserves immutable snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-archives-service-'));
  const db = openDatabase(join(directory, 'test.db'));
  try {
    const actors = archiveFixture(db);
    const list = createArchiveList(db, actors.owner, 'Net archive');
    addArchiveMember(db, list.id, actors.owner, 'member');
    assert.deepEqual(getArchiveList(db, list.id, actors.member)?.capabilities, {
      canManageContents: true,
      canManageAccounts: false,
    });
    await assert.rejects(async () => addArchiveSource(db, list.id, actors.member, 'other'), { code: 'ARCHIVE_LIST_FORBIDDEN' });
    addArchiveSource(db, list.id, actors.admin, 'other');
    db.prepare(`INSERT INTO session_members (id, session_id, user_id, role, version, created_at, updated_at)
      VALUES ('membership-member-active', 'active', 'member', 'viewer', 1, ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO session_members (id, session_id, user_id, role, version, created_at, updated_at)
      VALUES ('membership-member-deleted', 'deleted', 'member', 'viewer', 1, ?, ?)`).run(now, now);
    await assert.rejects(async () => createArchiveSnapshot(db, list.id, actors.member, {
      sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'active',
    }), { code: 'ARCHIVE_SESSION_NOT_CLOSED' });
    await assert.rejects(async () => createArchiveSnapshot(db, list.id, actors.member, {
      sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'deleted',
    }), { code: 'ARCHIVE_SESSION_NOT_CLOSED' });
    await assert.rejects(async () => createArchiveSnapshot(db, list.id, actors.member, {
      sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed',
    }), { code: 'ARCHIVE_LIST_FORBIDDEN' });
    db.prepare(`INSERT INTO session_members (id, session_id, user_id, role, version, created_at, updated_at)
      VALUES ('membership-member-closed', 'closed', 'member', 'viewer', 1, ?, ?)`).run(now, now);
    await assert.rejects(async () => createArchiveSnapshot(db, list.id, actors.member, {
      sourceUserId: 'member', sourceKind: 'collaboration', sourceSessionId: 'closed',
    }), { code: 'ARCHIVE_SOURCE_NOT_AUTHORIZED' });
    const archive = createArchiveSnapshot(db, list.id, actors.member, {
      sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed',
    });
    assert.equal(archive.logCount, 2);
    assert.deepEqual(db.prepare('SELECT ordinal, source_sync_id, remarks FROM public_archive_list_logs WHERE archive_session_id = ? ORDER BY ordinal').all(archive.id), [
      { ordinal: 1, source_sync_id: 'log-a', remarks: 'before' }, { ordinal: 2, source_sync_id: 'log-b', remarks: 'before' },
    ]);
    const adminArchive = createArchiveSnapshot(db, list.id, actors.admin, {
      sourceUserId: 'other', sourceKind: 'collaboration', sourceSessionId: 'other-closed',
    });
    assert.equal(adminArchive.sourceUserId, 'other');
    assert.equal(adminArchive.logCount, 0);
    assert.equal(refreshArchiveSnapshot(db, list.id, adminArchive.id, actors.admin).logCount, 0);
    db.prepare("UPDATE logs SET remarks = 'after', deleted_at = ? WHERE sync_id = 'log-a'").run(now);
    assert.deepEqual(db.prepare('SELECT ordinal, source_sync_id, remarks FROM public_archive_list_logs WHERE archive_session_id = ? ORDER BY ordinal').all(archive.id), [
      { ordinal: 1, source_sync_id: 'log-a', remarks: 'before' }, { ordinal: 2, source_sync_id: 'log-b', remarks: 'before' },
    ]);
    await assert.rejects(async () => createArchiveSnapshot(db, list.id, actors.member, {
      sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed',
    }), { code: 'ARCHIVE_SESSION_ALREADY_ADDED' });
    assert.equal(refreshArchiveSnapshot(db, list.id, archive.id, actors.member).logCount, 1);
    assert.deepEqual(db.prepare('SELECT ordinal, source_sync_id, remarks FROM public_archive_list_logs WHERE archive_session_id = ? ORDER BY ordinal').all(archive.id), [
      { ordinal: 1, source_sync_id: 'log-b', remarks: 'before' },
    ]);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('archive service rejects inactive member and source targets without writing rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-archives-targets-'));
  const db = openDatabase(join(directory, 'test.db'));
  try {
    const actors = archiveFixture(db);
    const list = createArchiveList(db, actors.owner, 'Net archive');
    db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at, disabled_at)
      VALUES ('disabled', 'disabled', 'hash', 'user', ?, ?, ?)`).run(now, now, now);
    db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at, deleted_at)
      VALUES ('removed', 'removed', 'hash', 'user', ?, ?, ?)`).run(now, now, now);
    for (const target of ['unknown', 'disabled', 'removed']) {
      assert.throws(() => addArchiveMember(db, list.id, actors.owner, target), { code: 'USER_NOT_FOUND' });
      assert.throws(() => addArchiveSource(db, list.id, actors.owner, target), { code: 'USER_NOT_FOUND' });
    }
    assert.equal(db.prepare('SELECT COUNT(*) FROM public_archive_list_members WHERE list_id = ?').pluck().get(list.id), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM public_archive_list_sources WHERE list_id = ?').pluck().get(list.id), 0);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('archive management mutations advance list recency', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-archives-recency-'));
  const db = openDatabase(join(directory, 'test.db'));
  try {
    const actors = archiveFixture(db);
    const first = createArchiveList(db, actors.owner, 'First');
    const second = createArchiveList(db, actors.owner, 'Second');
    db.prepare(`UPDATE public_archive_lists SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(first.id);
    db.prepare(`UPDATE public_archive_lists SET updated_at = '2001-01-01T00:00:00.000Z' WHERE id = ?`).run(second.id);
    addArchiveMember(db, first.id, actors.owner, 'member');
    const updatedAt = db.prepare('SELECT updated_at FROM public_archive_lists WHERE id = ?').pluck().get(first.id);
    assert.ok(String(updatedAt) > '2001-01-01T00:00:00.000Z');
    assert.deepEqual(listArchiveLists(db, actors.owner).map((list) => list.id), [first.id, second.id]);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('archive service manages source catalog and list lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-archives-lifecycle-'));
  const db = openDatabase(join(directory, 'test.db'));
  try {
    const actors = archiveFixture(db);
    const list = createArchiveList(db, actors.owner, 'Net archive');
    addArchiveMember(db, list.id, actors.owner, 'member');
    addArchiveSource(db, list.id, actors.owner, 'other');
    db.prepare(`INSERT INTO session_members (id, session_id, user_id, role, version, created_at, updated_at)
      VALUES ('membership-member-closed-catalog', 'closed', 'member', 'viewer', 1, ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO session_members (id, session_id, user_id, role, version, created_at, updated_at)
      VALUES ('membership-member-other-closed', 'other-closed', 'member', 'viewer', 1, ?, ?)`).run(now, now);
    assert.equal(listAvailableArchiveSessions(db, list.id, actors.owner, { page: 1, pageSize: 25, includeDeleted: false }).items.length, 1);
    const memberCatalog = listAvailableArchiveSessions(db, list.id, actors.member, { page: 1, pageSize: 25, includeDeleted: false });
    assert.equal(memberCatalog.total, 2);
    assert.deepEqual(
      memberCatalog.items.map((item) => item.sessionId).sort(),
      ['closed', 'other-closed'],
    );
    const collaborationPage = listAvailableArchiveSessions(db, list.id, actors.member, {
      page: 2, pageSize: 1, source: 'collaboration', includeDeleted: false,
    });
    assert.equal(collaborationPage.total, 2);
    assert.equal(collaborationPage.totalPages, 2);
    assert.equal(collaborationPage.items.length, 1);
    assert.equal(collaborationPage.items[0].source, 'collaboration');
    const personalPage = listAvailableArchiveSessions(db, list.id, actors.member, {
      page: 1, pageSize: 1, source: 'personal', includeDeleted: false,
    });
    assert.equal(personalPage.total, 0);
    assert.deepEqual(personalPage.items, []);
    const first = createArchiveSnapshot(db, list.id, actors.owner, { sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed' });
    db.prepare(`INSERT INTO sessions (id, title, status, owner_user_id, version, event_seq, min_retained_seq, created_at, updated_at, closed_at)
      VALUES ('closed-2', 'Closed two', 'closed', 'owner', 1, 0, 0, ?, ?, ?)`).run(now, now, now);
    db.prepare(`INSERT INTO session_members (id, session_id, user_id, role, version, created_at, updated_at)
      VALUES ('membership-owner-closed-2', 'closed-2', 'owner', 'owner', 1, ?, ?)`).run(now, now);
    const second = createArchiveSnapshot(db, list.id, actors.owner, { sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed-2' });
    reorderArchiveSessions(db, list.id, actors.owner, [second.id, first.id]);
    assert.deepEqual(db.prepare('SELECT id, display_order FROM public_archive_list_sessions WHERE list_id = ? ORDER BY display_order').all(list.id), [{ id: second.id, display_order: 0 }, { id: first.id, display_order: 1 }]);
    const otherList = createArchiveList(db, actors.owner, 'Other list');
    const foreign = createArchiveSnapshot(db, otherList.id, actors.owner, { sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed' });
    assert.throws(() => reorderArchiveSessions(db, list.id, actors.owner, [second.id, foreign.id]), { code: 'VALIDATION_FAILED' });
    assert.throws(() => reorderArchiveSessions(db, list.id, actors.owner, [second.id, second.id]), { code: 'VALIDATION_FAILED' });
    assert.deepEqual(db.prepare('SELECT id, display_order FROM public_archive_list_sessions WHERE list_id = ? ORDER BY display_order').all(list.id), [{ id: second.id, display_order: 0 }, { id: first.id, display_order: 1 }]);
    publishArchiveList(db, list.id, actors.member);
    assert.equal(getArchiveList(db, list.id, actors.member)?.isPublished, true);
    unpublishArchiveList(db, list.id, actors.member);
    removeArchiveSession(db, list.id, first.id, actors.member);
    assert.equal(db.prepare('SELECT COUNT(*) FROM public_archive_list_logs WHERE archive_session_id = ?').pluck().get(first.id), 0);
    softDeleteArchiveList(db, list.id, actors.member);
    assert.equal(getArchiveList(db, list.id, actors.owner), undefined);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('archive service snapshots only closed non-deleted personal-cloud records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-archives-personal-'));
  const db = openDatabase(join(directory, 'test.db'));
  try {
    const actors = archiveFixture(db);
    const snapshot = validatePersonalSnapshot({ version: 1, exportedAt: now, sessions: [
      { session_id: 'personal-closed', title: 'Personal closed', status: 'closed', created_at: now, updated_at: now, closed_at: now, deleted_at: null },
      { session_id: 'personal-deleted', title: 'Personal deleted', status: 'closed', created_at: now, updated_at: now, closed_at: now, deleted_at: now },
      { session_id: 'personal-active', title: 'Personal active', status: 'active', created_at: now, updated_at: now, closed_at: null, deleted_at: null },
    ], logs: [
      { sync_id: 'personal-log', session_id: 'personal-closed', time: '10:00', controller: 'BR5AI', callsign: 'BG5CCC', rst_sent: null, rst_rcvd: null, qth: null, device: null, power: null, antenna: null, height: null, remarks: 'frozen', created_at: now, updated_at: now, deleted_at: null, source_device_id: null },
    ] });
    db.prepare(`INSERT INTO personal_cloud_snapshots (user_id, revision, format_version, snapshot_json, session_count, log_count, byte_size, checksum, created_at, updated_at)
      VALUES ('owner', 1, 1, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshot.serialized, snapshot.sessionCount, snapshot.logCount, snapshot.byteSize, snapshot.checksum, now, now);
    const list = createArchiveList(db, actors.owner, 'Personal archive');
    const archive = createArchiveSnapshot(db, list.id, actors.owner, { sourceUserId: 'owner', sourceKind: 'personal', sourceSessionId: 'personal-closed' });
    assert.equal(db.prepare('SELECT remarks FROM public_archive_list_logs WHERE archive_session_id = ?').pluck().get(archive.id), 'frozen');
    await assert.rejects(async () => createArchiveSnapshot(db, list.id, actors.owner, {
      sourceUserId: 'owner', sourceKind: 'personal', sourceSessionId: 'personal-deleted',
    }), { code: 'ARCHIVE_SESSION_NOT_CLOSED' });
    await assert.rejects(async () => createArchiveSnapshot(db, list.id, actors.owner, {
      sourceUserId: 'owner', sourceKind: 'personal', sourceSessionId: 'personal-active',
    }), { code: 'ARCHIVE_SESSION_NOT_CLOSED' });
    await assert.rejects(async () => createArchiveSnapshot(db, list.id, actors.member, {
      sourceUserId: 'owner', sourceKind: 'personal', sourceSessionId: 'personal-closed',
    }), { code: 'ARCHIVE_LIST_FORBIDDEN' });
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

function candidateFixture(db: ReturnType<typeof openDatabase>) {
  const actors = archiveFixture(db);
  const user = db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
    VALUES (?, ?, 'hash', 'user', ?, ?)`);
  user.run('peer', 'Peer', now, now);
  user.run('ghost', 'ghost', now, now);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at, disabled_at)
    VALUES ('blocked', 'blocked', 'hash', 'user', ?, ?, ?)`).run(now, now, now);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at, deleted_at)
    VALUES ('gone', 'gone', 'hash', 'user', ?, ?, ?)`).run(now, now, now);
  db.prepare(`INSERT INTO sessions
    (id, title, status, owner_user_id, version, event_seq, min_retained_seq, created_at, updated_at, closed_at)
    VALUES ('ghost-session', 'Ghost collaboration', 'active', 'ghost', 1, 0, 0, ?, ?, NULL)`).run(now, now);
  const membership = db.prepare(`INSERT INTO session_members
    (id, session_id, user_id, role, version, created_at, updated_at, removed_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)`);
  membership.run('candidate-member-closed', 'closed', 'member', 'viewer', now, now, null);
  membership.run('candidate-peer-active', 'active', 'peer', 'viewer', now, now, null);
  membership.run('candidate-blocked-closed', 'closed', 'blocked', 'viewer', now, now, null);
  membership.run('candidate-gone-closed', 'closed', 'gone', 'viewer', now, now, null);
  membership.run('candidate-ghost-owner', 'ghost-session', 'ghost', 'owner', now, now, null);
  membership.run('candidate-ghost-actor', 'ghost-session', 'owner', 'viewer', now, now, now);
  return actors;
}

test('archive candidate accounts stay scoped to shared collaboration sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-archives-candidates-'));
  const db = openDatabase(join(directory, 'test.db'));
  try {
    const actors = candidateFixture(db);
    const list = createArchiveList(db, actors.owner, 'Candidates');

    const owned = listArchiveCandidateAccounts(db, list.id, actors.owner, {
      kind: 'members', page: 1, pageSize: 25,
    });
    assert.deepEqual(owned.items, [
      { userId: 'member', username: 'member' },
      { userId: 'peer', username: 'Peer' },
    ]);
    assert.equal(owned.total, 2);
    assert.equal(owned.totalPages, 1);

    for (const q of ['other', 'OTHER', 'ghost', 'blocked', 'gone', 'admin', 'owner']) {
      assert.deepEqual(
        listArchiveCandidateAccounts(db, list.id, actors.owner, { kind: 'members', page: 1, pageSize: 25, q }).items,
        [],
        `q=${q} must not act as a global directory`,
      );
    }
    assert.deepEqual(
      listArchiveCandidateAccounts(db, list.id, actors.owner, { kind: 'sources', page: 1, pageSize: 25, q: 'pEe' }).items,
      [{ userId: 'peer', username: 'Peer' }],
    );

    addArchiveMember(db, list.id, actors.owner, 'member');
    assert.deepEqual(
      listArchiveCandidateAccounts(db, list.id, actors.owner, { kind: 'members', page: 1, pageSize: 25 }).items,
      [{ userId: 'peer', username: 'Peer' }],
    );
    assert.deepEqual(
      listArchiveCandidateAccounts(db, list.id, actors.owner, { kind: 'sources', page: 1, pageSize: 25 }).items,
      [{ userId: 'member', username: 'member' }, { userId: 'peer', username: 'Peer' }],
    );
    addArchiveSource(db, list.id, actors.owner, 'peer');
    assert.deepEqual(
      listArchiveCandidateAccounts(db, list.id, actors.owner, { kind: 'sources', page: 1, pageSize: 25 }).items,
      [{ userId: 'member', username: 'member' }],
    );

    const administrated = listArchiveCandidateAccounts(db, list.id, actors.admin, {
      kind: 'members', page: 1, pageSize: 25,
    });
    assert.deepEqual(administrated.items.map((item) => item.userId), ['admin', 'ghost', 'other', 'owner', 'peer']);
    assert.equal(administrated.total, 5);
    const paged = listArchiveCandidateAccounts(db, list.id, actors.admin, {
      kind: 'members', page: 2, pageSize: 2,
    });
    assert.equal(paged.total, 5);
    assert.equal(paged.totalPages, 3);
    assert.deepEqual(paged.items.map((item) => item.userId), ['other', 'owner']);
    assert.deepEqual(
      listArchiveCandidateAccounts(db, list.id, actors.admin, { kind: 'members', page: 1, pageSize: 25, q: 'OTH' }).items,
      [{ userId: 'other', username: 'other' }],
    );

    assert.throws(
      () => listArchiveCandidateAccounts(db, list.id, actors.member, { kind: 'members', page: 1, pageSize: 25 }),
      { status: 403, code: 'ARCHIVE_LIST_FORBIDDEN' },
    );
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('archive publication requires at least one archived session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-archives-empty-publish-'));
  const db = openDatabase(join(directory, 'test.db'));
  try {
    const actors = archiveFixture(db);
    const list = createArchiveList(db, actors.owner, 'Empty archive');
    assert.throws(() => publishArchiveList(db, list.id, actors.owner), {
      status: 422,
      code: 'ARCHIVE_LIST_EMPTY',
    });
    assert.equal(getArchiveList(db, list.id, actors.owner)?.isPublished, false);
    unpublishArchiveList(db, list.id, actors.owner);
    const snapshot = createArchiveSnapshot(db, list.id, actors.owner, {
      sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed',
    });
    publishArchiveList(db, list.id, actors.owner);
    assert.equal(getArchiveList(db, list.id, actors.owner)?.isPublished, true);
    publishArchiveList(db, list.id, actors.owner);
    assert.equal(getArchiveList(db, list.id, actors.owner)?.isPublished, true);
    removeArchiveSession(db, list.id, snapshot.id, actors.owner);
    softDeleteArchiveList(db, list.id, actors.owner);
    assert.equal(getArchiveList(db, list.id, actors.owner), undefined);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('fresh migrations create the public archive tables and query indexes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-archives-'));
  const db = openDatabase(join(directory, 'test.db'));
  try {
    for (const table of [
      'public_archive_lists',
      'public_archive_list_members',
      'public_archive_list_sources',
      'public_archive_list_sessions',
      'public_archive_list_logs',
      'public_archive_aliases',
    ]) {
      assert.ok(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        `missing table: ${table}`,
      );
    }
    assert.ok(db.prepare("SELECT name FROM pragma_table_info('public_archive_aliases') WHERE name = 'display_alias'").get());

    for (const index of [
      'idx_public_archive_list_sessions_list_order',
      'idx_public_archive_list_logs_session_ordinal',
      'idx_public_archive_list_members_user',
      'idx_public_archive_list_sources_user',
    ]) {
      assert.ok(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index),
        `missing index: ${index}`,
      );
    }
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('public archive aliases normalize case and reject malformed or reserved paths', () => {
  assert.equal(normalizePublicArchiveAlias(' BR5AI '), 'br5ai');
  assert.equal(normalizePublicArchiveAlias('archive-2026'), 'archive-2026');

  for (const alias of ['', '-archive', 'archive_', 'archive.', 'a'.repeat(64)]) {
    assert.throws(
      () => normalizePublicArchiveAlias(alias),
      { status: 422, code: 'ARCHIVE_ALIAS_INVALID' },
    );
  }

  for (const alias of [
    'api', 'admin', 'app', 'assets', 'favicon.ico', 'health', 'live', 'robots.txt', 'web', 'ws',
  ]) {
    assert.throws(
      () => normalizePublicArchiveAlias(alias.toUpperCase()),
      { status: 422, code: 'ARCHIVE_ALIAS_INVALID' },
    );
  }
});

test('public archive row mappers omit source account and audit fields', () => {
  const list = publicArchiveListDto({
    id: 'list-1',
    title: 'Archive List',
    owner_user_id: 'owner-1',
    is_published: 1,
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    unpublished_at: null,
    deleted_at: null,
  });
  const session = publicArchiveSessionDto({
    id: 'archive-session-1',
    list_id: 'list-1',
    title: 'Closed Net',
    closed_at: '2026-08-18T00:00:00.000Z',
    display_order: 0,
    log_count: 1,
  });
  const log = publicArchiveLogDto({
    archive_session_id: 'archive-session-1',
    source_sync_id: 'source-log-1',
    ordinal: 1,
    time: '12:00',
    controller: 'BR5AI',
    callsign: 'BG5AAA',
    rst_sent: null,
    rst_rcvd: null,
    qth: null,
    device: null,
    power: null,
    antenna: null,
    height: null,
    remarks: null,
  });

  assert.deepEqual(list, { id: 'list-1', title: 'Archive List' });
  assert.deepEqual(session, {
    id: 'archive-session-1',
    title: 'Closed Net',
    closedAt: '2026-08-18T00:00:00.000Z',
    displayOrder: 0,
    logCount: 1,
  });
  assert.deepEqual(log, {
    ordinal: 1,
    time: '12:00',
    controller: 'BR5AI',
    callsign: 'BG5AAA',
    rstSent: null,
    rstRcvd: null,
    qth: null,
    device: null,
    power: null,
    antenna: null,
    height: null,
    remarks: null,
  });
});

describe('public archive list HTTP APIs', { concurrency: false }, () => {
  const config: AppConfig = {
    port: 0, dbPath: ':memory:', jwtSecret: 'public-archive-list-api-test-secret-604cbc5b',
    jwtIssuer: 'public-archive-list-api-test', bootstrapSecret: 'test-bootstrap-secret',
    inviteHmacKey: 'test-invite-hmac-key', publicShareHmacKey: 'test-public-share-hmac-key',
    accessTokenTtlSeconds: 300, refreshTokenTtlSeconds: 3_600, corsOrigins: [], trustProxy: false,
    jsonBodyLimit: '1mb', rateLimitEnabled: false, environment: 'test',
  };
  let directory: string;
  let db: ReturnType<typeof openDatabase>;
  let server: Server;
  let baseUrl: string;
  let webIndex: string;

  function token(userId: string, role: 'user' | 'admin'): string {
    return jwt.sign({ type: 'access', role }, config.jwtSecret, {
      algorithm: 'HS256', subject: userId, jwtid: randomUUID(), issuer: config.jwtIssuer,
      audience: 'openlogtool-v1', expiresIn: 300,
    });
  }

  async function request(method: string, path: string, accessToken?: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json', 'x-request-id': randomUUID(),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, unknown> : {}, text };
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-archives-http-'));
    db = openDatabase(join(directory, 'test.db'));
    const actors = archiveFixture(db);
    void actors;
    server = createServer(createApp({ db, config }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    webIndex = await readFile(join(process.cwd(), 'web/dist/index.html'), 'utf8');
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  test('manages, publishes, and exposes immutable public archive reads', async () => {
    const owner = token('owner', 'user');
    const created = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Zhejiang net' });
    assert.equal(created.status, 201, created.text);
    const list = created.body.data as { id: string };
    assert.ok(list.id);
    assert.equal((await request('POST', '/api/v1/public-archive-lists', owner, { title: 'invalid', extra: true })).status, 422);
    assert.equal((await request('GET', '/api/v1/public-archive-lists?unknown=yes', owner)).status, 422);
    assert.equal((await request('GET', `/api/v1/public/archive-lists/${list.id}`)).status, 404);
    const snapshot = await request('POST', `/api/v1/public-archive-lists/${list.id}/sessions`, owner, {
      sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed',
    });
    assert.equal(snapshot.status, 201, snapshot.text);
    const snapshotData = snapshot.body.data as { id: string; logCount: number };
    const archiveSessionId = snapshotData.id;
    assert.equal(snapshotData.logCount, 2);
    db.prepare("UPDATE logs SET deleted_at = ? WHERE sync_id = 'log-a'").run(now);
    const refreshed = await request('PUT', `/api/v1/public-archive-lists/${list.id}/sessions/${archiveSessionId}/refresh`, owner, {});
    assert.equal(refreshed.status, 200, refreshed.text);
    assert.equal((refreshed.body.data as { logCount: number }).logCount, 1);
    const managementDetail = await request('GET', `/api/v1/public-archive-lists/${list.id}`, owner);
    assert.equal(managementDetail.status, 200, managementDetail.text);
    const managementData = managementDetail.body.data as { sessions: Array<{ id: string; title: string; logCount: number; displayOrder: number; snapshotAt: string }>; capabilities: { canManageContents: boolean; canManageAccounts: boolean } };
    assert.equal(managementData.sessions[0].id, archiveSessionId);
    assert.equal(managementData.sessions[0].logCount, 1);
    assert.equal(managementData.capabilities.canManageContents, true);
    assert.equal(managementData.capabilities.canManageAccounts, true);
    assert.equal((await request('POST', `/api/v1/public-archive-lists/${list.id}/publish`, owner)).status, 200);
    const publicList = await request('GET', `/api/v1/public/archive-lists/${list.id}`);
    assert.equal(publicList.status, 200, publicList.text);
    assert.equal(publicList.headers.get('cache-control'), 'no-store');
    const detail = await request('GET', `/api/v1/public/archive-lists/${list.id}/sessions/${archiveSessionId}`);
    assert.equal(detail.status, 200, detail.text);
    assert.deepEqual(Object.keys(detail.body.data as Record<string, unknown>).sort(), ['logs', 'session']);
    assert.equal((await request('POST', `/api/v1/public-archive-lists/${list.id}/unpublish`, owner)).status, 200);
    assert.equal((await request('GET', `/api/v1/public/archive-lists/${list.id}`)).status, 404);
    assert.equal((await request('POST', `/api/v1/public-archive-lists/${list.id}/publish`, owner)).status, 200);
    assert.equal((await request('DELETE', `/api/v1/public-archive-lists/${list.id}`, owner)).status, 204);
    assert.equal((await request('GET', `/api/v1/public/archive-lists/${list.id}/sessions/${archiveSessionId}`)).status, 404);
  });

  test('enforces member, owner, and current-admin archive permissions', async () => {
    const owner = token('owner', 'user');
    const member = token('member', 'user');
    const admin = token('admin', 'admin');
    const created = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Permissions' });
    const listId = (created.body.data as { id: string }).id;
    assert.equal((await request('PUT', `/api/v1/public-archive-lists/${listId}/members/member`, owner, {})).status, 204);
    assert.equal((await request('GET', `/api/v1/public-archive-lists/${listId}`, token('other', 'user'))).status, 403);
    assert.equal((await request('PUT', `/api/v1/public-archive-lists/${listId}/sources/other`, member, {})).status, 403);
    assert.equal((await request('PUT', `/api/v1/public-archive-lists/${listId}/sources/other`, admin, {})).status, 204);
    assert.equal((await request('PATCH', `/api/v1/public-archive-lists/${listId}`, member, { title: 'Member edit' })).status, 200);
  });

  test('restricts archive account metadata to the owner or current administrator', async () => {
    const owner = token('owner', 'user');
    const member = token('member', 'user');
    const admin = token('admin', 'admin');
    const created = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Account metadata' });
    const listId = (created.body.data as { id: string }).id;
    assert.equal((await request('PUT', `/api/v1/public-archive-lists/${listId}/members/member`, owner, {})).status, 204);
    assert.equal((await request('PUT', `/api/v1/public-archive-lists/${listId}/sources/other`, owner, {})).status, 204);

    for (const kind of ['members', 'sources']) {
      const forbidden = await request('GET', `/api/v1/public-archive-lists/${listId}/${kind}`, member);
      assert.equal(forbidden.status, 403, forbidden.text);
      assert.equal((forbidden.body.error as { code: string }).code, 'ARCHIVE_LIST_FORBIDDEN');
      assert.deepEqual(Object.keys(forbidden.body), ['error']);
      assert.equal('data' in forbidden.body, false);
      assert.equal((await request('GET', `/api/v1/public-archive-lists/${listId}/${kind}`, owner)).status, 200);
      assert.equal((await request('GET', `/api/v1/public-archive-lists/${listId}/${kind}`, admin)).status, 200);
    }
  });

  test('marks management authentication failures as no-store', async () => {
    for (const accessToken of [undefined, 'not-a-valid-token']) {
      const result = await request('GET', '/api/v1/public-archive-lists', accessToken);
      assert.equal(result.status, 401, result.text);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
  });

  test('paginates archive lists with a strict bounded scalar query contract', async () => {
    const owner = token('owner', 'user');
    const first = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Page one' });
    const second = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Page two' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const page = await request('GET', '/api/v1/public-archive-lists?page=2&pageSize=1', owner);
    assert.equal(page.status, 200, page.text);
    const data = page.body.data as { items: unknown[]; page: number; pageSize: number; total: number; totalPages: number };
    assert.equal(data.items.length, 1);
    assert.equal(data.page, 2);
    assert.equal(data.pageSize, 1);
    assert.ok(data.total >= 2);
    assert.equal(data.totalPages, data.total);
    for (const path of [
      '/api/v1/public-archive-lists?page=0',
      '/api/v1/public-archive-lists?pageSize=101',
      '/api/v1/public-archive-lists?page=1&page=2',
      '/api/v1/public-archive-lists?unknown=value',
    ]) {
      const result = await request('GET', path, owner);
      assert.equal(result.status, 422, result.text);
      assert.equal((result.body.error as { code: string }).code, 'VALIDATION_FAILED');
    }
  });

  test('rejects query strings on every non-collection archive management and alias route', async () => {
    const owner = token('owner', 'user');
    const admin = token('admin', 'admin');
    const created = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Strict queries' });
    const listId = (created.body.data as { id: string }).id;
    const routes: Array<[string, string, string | undefined, unknown]> = [
      ['POST', '/api/v1/public-archive-lists?x=1', owner, { title: 'Invalid' }],
      ['GET', `/api/v1/public-archive-lists/${listId}?x=1`, owner, undefined],
      ['PATCH', `/api/v1/public-archive-lists/${listId}?x=1`, owner, { title: 'Invalid' }],
      ['POST', `/api/v1/public-archive-lists/${listId}/publish?x=1`, owner, {}],
      ['GET', `/api/v1/public-archive-lists/${listId}/sources?x=1`, owner, undefined],
      ['PUT', `/api/v1/public-archive-lists/${listId}/members/member?x=1`, owner, {}],
      ['GET', `/api/v1/public-archive-lists/${listId}/available-sessions?x=1`, owner, undefined],
      ['POST', `/api/v1/public-archive-lists/${listId}/sessions?x=1`, owner, { sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed' }],
      ['PUT', `/api/v1/admin/public-archive-lists/${listId}/alias?x=1`, admin, { alias: 'strict-query' }],
    ];
    for (const [method, path, accessToken, body] of routes) {
      const result = await request(method, path, accessToken, body);
      assert.equal(result.status, 422, `${method} ${path}: ${result.text}`);
      assert.equal((result.body.error as { code: string }).code, 'VALIDATION_FAILED');
    }
    assert.equal((await request('POST', `/api/v1/public-archive-lists/${listId}/snapshots`, owner, {
      sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed',
    })).status, 404);
  });

  test('preserves display aliases while routing case-insensitively', async () => {
    const owner = token('owner', 'user');
    const admin = token('admin', 'admin');
    const created = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Alias list' });
    const listId = (created.body.data as { id: string }).id;
    assert.equal((await request('PUT', `/api/v1/admin/public-archive-lists/${listId}/alias`, owner, { alias: 'BR5AI' })).status, 403);
    assert.equal((await request('PUT', `/api/v1/admin/public-archive-lists/${listId}/alias`, admin, { alias: 'api' })).status, 422);
    const assigned = await request('PUT', `/api/v1/admin/public-archive-lists/${listId}/alias`, admin, { alias: 'BR5AI' });
    assert.equal(assigned.status, 200, assigned.text);
    assert.equal((assigned.body.data as { displayAlias: string }).displayAlias, 'BR5AI');
    const listed = await request('GET', '/api/v1/public-archive-lists?page=1&pageSize=100', admin);
    assert.equal((listed.body.data as { items: Array<{ id: string; displayAlias: string }> }).items.find((item) => item.id === listId)?.displayAlias, 'BR5AI');
    const snapshot = await request('POST', `/api/v1/public-archive-lists/${listId}/sessions`, owner, {
      sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed',
    });
    assert.equal(snapshot.status, 201, snapshot.text);
    const archiveSessionId = (snapshot.body.data as { id: string }).id;
    assert.equal((await request('POST', `/api/v1/public-archive-lists/${listId}/publish`, owner)).status, 200);
    assert.equal((await request('GET', '/api/v1/public/archive-aliases/BR5AI')).status, 200);
    const root = await fetch(`${baseUrl}/br5ai`);
    assert.equal(root.status, 200);
    const nested = await fetch(`${baseUrl}/br5ai/session/${archiveSessionId}`);
    assert.equal(nested.status, 200);
    assert.equal((await fetch(`${baseUrl}/br5ai/session/not-an-archive-session`)).status, 404);
    assert.equal((await request('DELETE', `/api/v1/public-archive-lists/${listId}/sessions/${archiveSessionId}`, owner, {})).status, 204);
    assert.equal((await fetch(`${baseUrl}/br5ai/session/${archiveSessionId}`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/not-published`)).status, 404);
    const second = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Collision' });
    const secondId = (second.body.data as { id: string }).id;
    const collision = await request('PUT', `/api/v1/admin/public-archive-lists/${secondId}/alias`, admin, { alias: 'br5ai' });
    assert.equal(collision.status, 409, collision.text);
    assert.equal((collision.body.error as { code: string }).code, 'ARCHIVE_ALIAS_TAKEN');
  });

  test('reserves root WebUI routes from archive aliases and serves their WebUI bundle', async () => {
    const owner = token('owner', 'user');
    const admin = token('admin', 'admin');
    const created = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Reserved aliases' });
    const listId = (created.body.data as { id: string }).id;
    for (const alias of ['login', 'register', 'bootstrap']) {
      const result = await request('PUT', `/api/v1/admin/public-archive-lists/${listId}/alias`, admin, { alias });
      assert.equal(result.status, 422, result.text);
      assert.equal((result.body.error as { code: string }).code, 'ARCHIVE_ALIAS_INVALID');
      const route = await fetch(`${baseUrl}/${alias}`);
      assert.equal(route.status, 200);
      assert.equal(await route.text(), webIndex);
    }
  });

  test('rejects publishing an archive list without archived sessions', async () => {
    const owner = token('owner', 'user');
    const created = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Empty publish' });
    const listId = (created.body.data as { id: string }).id;
    const rejected = await request('POST', `/api/v1/public-archive-lists/${listId}/publish`, owner, {});
    assert.equal(rejected.status, 422, rejected.text);
    assert.equal((rejected.body.error as { code: string }).code, 'ARCHIVE_LIST_EMPTY');
    assert.equal(
      ((await request('GET', `/api/v1/public-archive-lists/${listId}`, owner)).body.data as { isPublished: boolean }).isPublished,
      false,
    );
    assert.equal((await request('POST', `/api/v1/public-archive-lists/${listId}/sessions`, owner, {
      sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed',
    })).status, 201);
    const published = await request('POST', `/api/v1/public-archive-lists/${listId}/publish`, owner, {});
    assert.equal(published.status, 200, published.text);
    assert.equal((published.body.data as { isPublished: boolean }).isPublished, true);
  });

  test('exposes owner usernames and username-joined account rows', async () => {
    const owner = token('owner', 'user');
    const created = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Usernames' });
    const listId = (created.body.data as { id: string }).id;
    assert.equal((await request('PUT', `/api/v1/public-archive-lists/${listId}/members/member`, owner, {})).status, 204);
    assert.equal((await request('PUT', `/api/v1/public-archive-lists/${listId}/members/admin`, owner, {})).status, 204);
    assert.equal((await request('PUT', `/api/v1/public-archive-lists/${listId}/sources/other`, owner, {})).status, 204);

    const detail = await request('GET', `/api/v1/public-archive-lists/${listId}`, owner);
    assert.equal(detail.status, 200, detail.text);
    assert.equal((detail.body.data as { ownerUsername: string }).ownerUsername, 'owner');
    const listed = await request('GET', '/api/v1/public-archive-lists?page=1&pageSize=100', owner);
    assert.equal(
      (listed.body.data as { items: Array<{ id: string; ownerUsername: string }> }).items
        .find((item) => item.id === listId)?.ownerUsername,
      'owner',
    );

    const members = await request('GET', `/api/v1/public-archive-lists/${listId}/members`, owner);
    assert.equal(members.status, 200, members.text);
    assert.deepEqual(members.body.data, [
      { userId: 'admin', username: 'admin' },
      { userId: 'member', username: 'member' },
    ]);
    const sources = await request('GET', `/api/v1/public-archive-lists/${listId}/sources`, owner);
    assert.deepEqual(sources.body.data, [{ userId: 'other', username: 'other' }]);
  });

  test('adds archive members and sources by exact username', async () => {
    const owner = token('owner', 'user');
    const member = token('member', 'user');
    const created = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'By username' });
    const listId = (created.body.data as { id: string }).id;

    assert.equal((await request('PUT', `/api/v1/public-archive-lists/${listId}/members`, owner, { username: 'member' })).status, 204);
    assert.equal((await request('PUT', `/api/v1/public-archive-lists/${listId}/sources`, owner, { username: 'OTHER' })).status, 204);
    assert.deepEqual((await request('GET', `/api/v1/public-archive-lists/${listId}/members`, owner)).body.data, [
      { userId: 'member', username: 'member' },
    ]);
    assert.deepEqual((await request('GET', `/api/v1/public-archive-lists/${listId}/sources`, owner)).body.data, [
      { userId: 'other', username: 'other' },
    ]);

    for (const kind of ['members', 'sources']) {
      const missing = await request('PUT', `/api/v1/public-archive-lists/${listId}/${kind}`, owner, { username: 'nobody' });
      assert.equal(missing.status, 404, missing.text);
      assert.equal((missing.body.error as { code: string }).code, 'USER_NOT_FOUND');
      const forbidden = await request('PUT', `/api/v1/public-archive-lists/${listId}/${kind}`, member, { username: 'other' });
      assert.equal(forbidden.status, 403, forbidden.text);
      assert.equal((forbidden.body.error as { code: string }).code, 'ARCHIVE_LIST_FORBIDDEN');
      for (const body of [{ username: 'member', extra: true }, {}, { username: 1 }]) {
        const invalid = await request('PUT', `/api/v1/public-archive-lists/${listId}/${kind}`, owner, body);
        assert.equal(invalid.status, 422, invalid.text);
        assert.equal((invalid.body.error as { code: string }).code, 'VALIDATION_FAILED');
      }
      assert.equal(
        (await request('PUT', `/api/v1/public-archive-lists/${listId}/${kind}?x=1`, owner, { username: 'member' })).status,
        422,
      );
    }
  });

  test('serves candidate accounts without acting as a global user directory', async () => {
    const owner = token('owner', 'user');
    const member = token('member', 'user');
    const admin = token('admin', 'admin');
    db.prepare(`INSERT OR IGNORE INTO session_members (id, session_id, user_id, role, version, created_at, updated_at)
      VALUES ('candidate-http-member', 'closed', 'member', 'viewer', 1, ?, ?)`).run(now, now);
    const created = await request('POST', '/api/v1/public-archive-lists', owner, { title: 'Candidates HTTP' });
    const listId = (created.body.data as { id: string }).id;

    const ownerView = await request('GET', `/api/v1/public-archive-lists/${listId}/candidate-accounts?kind=members`, owner);
    assert.equal(ownerView.status, 200, ownerView.text);
    const ownerData = ownerView.body.data as { items: Array<Record<string, unknown>>; page: number; pageSize: number; total: number; totalPages: number };
    assert.deepEqual(ownerData.items, [{ userId: 'member', username: 'member' }]);
    assert.deepEqual({ page: ownerData.page, pageSize: ownerData.pageSize, total: ownerData.total, totalPages: ownerData.totalPages }, {
      page: 1, pageSize: 25, total: 1, totalPages: 1,
    });
    assert.deepEqual(Object.keys(ownerData.items[0]).sort(), ['userId', 'username']);

    const exact = await request('GET', `/api/v1/public-archive-lists/${listId}/candidate-accounts?kind=sources&q=other`, owner);
    assert.equal(exact.status, 200, exact.text);
    assert.deepEqual((exact.body.data as { items: unknown[] }).items, []);

    const administrated = await request('GET', `/api/v1/public-archive-lists/${listId}/candidate-accounts?kind=members`, admin);
    assert.equal(administrated.status, 200, administrated.text);
    assert.ok((administrated.body.data as { total: number }).total >= 4);
    assert.ok((administrated.body.data as { items: Array<{ userId: string }> }).items.some((item) => item.userId === 'other'));

    const forbidden = await request('GET', `/api/v1/public-archive-lists/${listId}/candidate-accounts?kind=members`, member);
    assert.equal(forbidden.status, 403, forbidden.text);
    assert.equal((forbidden.body.error as { code: string }).code, 'ARCHIVE_LIST_FORBIDDEN');

    for (const path of [
      `/api/v1/public-archive-lists/${listId}/candidate-accounts`,
      `/api/v1/public-archive-lists/${listId}/candidate-accounts?kind=owners`,
      `/api/v1/public-archive-lists/${listId}/candidate-accounts?kind=members&unknown=1`,
      `/api/v1/public-archive-lists/${listId}/candidate-accounts?kind=members&page=0`,
      `/api/v1/public-archive-lists/${listId}/candidate-accounts?kind=members&pageSize=101`,
      `/api/v1/public-archive-lists/${listId}/candidate-accounts?kind=members&kind=sources`,
    ]) {
      const result = await request('GET', path, owner);
      assert.equal(result.status, 422, `${path}: ${result.text}`);
      assert.equal((result.body.error as { code: string }).code, 'VALIDATION_FAILED');
    }
  });
});
