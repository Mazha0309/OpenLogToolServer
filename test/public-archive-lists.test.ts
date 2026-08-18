import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
    assert.deepEqual(db.prepare('SELECT ordinal, source_sync_id, remarks FROM public_archive_list_logs WHERE archive_session_id = ? ORDER BY ordinal').all(archive.id), [
      { ordinal: 1, source_sync_id: 'log-a', remarks: 'before' }, { ordinal: 2, source_sync_id: 'log-b', remarks: 'before' },
    ]);
    const adminArchive = createArchiveSnapshot(db, list.id, actors.admin, {
      sourceUserId: 'other', sourceKind: 'collaboration', sourceSessionId: 'other-closed',
    });
    assert.equal(adminArchive.sourceUserId, 'other');
    refreshArchiveSnapshot(db, list.id, adminArchive.id, actors.admin);
    db.prepare("UPDATE logs SET remarks = 'after', deleted_at = ? WHERE sync_id = 'log-a'").run(now);
    assert.deepEqual(db.prepare('SELECT ordinal, source_sync_id, remarks FROM public_archive_list_logs WHERE archive_session_id = ? ORDER BY ordinal').all(archive.id), [
      { ordinal: 1, source_sync_id: 'log-a', remarks: 'before' }, { ordinal: 2, source_sync_id: 'log-b', remarks: 'before' },
    ]);
    await assert.rejects(async () => createArchiveSnapshot(db, list.id, actors.member, {
      sourceUserId: 'owner', sourceKind: 'collaboration', sourceSessionId: 'closed',
    }), { code: 'ARCHIVE_SESSION_ALREADY_ADDED' });
    refreshArchiveSnapshot(db, list.id, archive.id, actors.member);
    assert.deepEqual(db.prepare('SELECT ordinal, source_sync_id, remarks FROM public_archive_list_logs WHERE archive_session_id = ? ORDER BY ordinal').all(archive.id), [
      { ordinal: 1, source_sync_id: 'log-b', remarks: 'before' },
    ]);
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
