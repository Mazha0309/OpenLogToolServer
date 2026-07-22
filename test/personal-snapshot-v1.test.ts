import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { createApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import { createClientSessionDatabaseBackupV7 } from '../src/personal-snapshot/database-backup-v7';
import { validatePersonalSnapshot } from '../src/personal-snapshot/model';

interface HttpResult {
  status: number;
  headers: Headers;
  body: any;
}

const JWT_SECRET = 'personal-snapshot-test-jwt-secret-4c80af09-e2d1-46c4-93be';
const JWT_ISSUER = 'personal-snapshot-test';
const OWNER_ID = 'personal-snapshot-owner';
const OTHER_ID = 'personal-snapshot-other';
const NOW = '2026-07-18T12:00:00.000Z';

function accessToken(userId: string): string {
  return jwt.sign(
    { type: 'access', role: 'user', jti: randomUUID(), av: 1 },
    JWT_SECRET,
    {
      algorithm: 'HS256',
      issuer: JWT_ISSUER,
      audience: 'openlogtool-v1',
      subject: userId,
      expiresIn: 300,
    },
  );
}

function sampleSnapshot(exportedAt = '2026-07-18T12:01:02.345+08:00') {
  return {
    version: 1,
    exportedAt,
    sessions: [
      {
        session_id: 'local-session-2026-07-18',
        title: '晚间点名',
        status: 'closed',
        created_at: '2026-07-18T19:30:00.000+08:00',
        updated_at: '2026-07-18T20:45:00.123+08:00',
        closed_at: '2026-07-18T20:45:00.123+08:00',
        deleted_at: null,
      },
    ],
    logs: [
      {
        sync_id: 'local-log-1',
        session_id: 'local-session-2026-07-18',
        time: '2026-07-18T19:31:59.987+08:00',
        controller: 'BG5AAA',
        callsign: 'BG5CRL',
        rst_sent: '59',
        rst_rcvd: '58',
        qth: '杭州',
        device: 'IC-9700',
        power: '25W',
        antenna: 'X520',
        height: '100m',
        remarks: '完整时间保留',
        created_at: '2026-07-18T19:32:00.001+08:00',
        updated_at: '2026-07-18T19:32:00.002+08:00',
        deleted_at: null,
        source_device_id: 'windows-shack-pc',
      },
    ],
  };
}

test('personal snapshot checksum ignores export time and row ordering', () => {
  const first: any = sampleSnapshot();
  first.sessions.push({
    ...first.sessions[0],
    session_id: 'another-session',
    status: 'active',
    closed_at: null,
  });
  first.logs.push({
    ...first.logs[0],
    sync_id: 'another-log',
    session_id: 'another-session',
  });
  const reordered = {
    ...first,
    exportedAt: '2026-07-19T00:00:00.000Z',
    sessions: [...first.sessions].reverse(),
    logs: [...first.logs].reverse(),
  };
  assert.equal(
    validatePersonalSnapshot(first).checksum,
    validatePersonalSnapshot(reordered).checksum,
  );
});

test('personal snapshot checksum follows the cross-client canonical vector', () => {
  const empty = sampleSnapshot();
  empty.sessions = [];
  empty.logs = [];
  assert.equal(
    validatePersonalSnapshot(empty).checksum,
    'ad968e72c01b6c7dbe0b5de438b5d752ed6372b7f9090d3ff3c3694b5c1e431a',
  );
  assert.equal(
    validatePersonalSnapshot(sampleSnapshot()).checksum,
    'b00518f22d8b76988bdc3c7c0228e5ef8b3b5fd13755da5881f3406d07d6d510',
  );
});

test('client v7 backup contains exactly one selected Session', () => {
  const snapshot: any = sampleSnapshot();
  snapshot.sessions.push({
    ...snapshot.sessions[0],
    session_id: 'another-session',
    title: 'Another net',
  });
  snapshot.logs.push({
    ...snapshot.logs[0],
    sync_id: 'another-log',
    session_id: 'another-session',
    callsign: 'BG5OTHER',
  });

  const backup = createClientSessionDatabaseBackupV7(
    snapshot,
    'local-session-2026-07-18',
    NOW,
  );
  assert.deepEqual(backup.sessions, [snapshot.sessions[0]]);
  assert.deepEqual(backup.logs, [snapshot.logs[0]]);
  assert.deepEqual(backup.dictionary_items, []);
  assert.equal(backup.exportedAt, NOW);
});

test('personal snapshot accepts archived sessions and rejects duplicate log IDs globally', () => {
  const archived: any = sampleSnapshot();
  archived.sessions[0].status = 'archived';
  assert.equal(validatePersonalSnapshot(archived).snapshot.sessions[0].status, 'archived');

  const duplicateAcrossSessions: any = sampleSnapshot();
  duplicateAcrossSessions.sessions.push({
    ...duplicateAcrossSessions.sessions[0],
    session_id: 'second-session',
  });
  duplicateAcrossSessions.logs.push({
    ...duplicateAcrossSessions.logs[0],
    session_id: 'second-session',
  });
  assert.throws(
    () => validatePersonalSnapshot(duplicateAcrossSessions),
    (error: any) => error?.code === 'VALIDATION_FAILED',
  );
});

test('personal snapshot preserves RFC 3339 and legacy time-only log values', () => {
  for (const time of [
    '2026-07-18T19:31:59.987+08:00',
    '2024-02-29T00:00:00Z',
    '0:00',
    '8:05',
    '9:05:07',
    '08:05',
    '20:15:59',
  ]) {
    const snapshot = sampleSnapshot();
    snapshot.logs[0].time = time;
    assert.equal(validatePersonalSnapshot(snapshot).snapshot.logs[0].time, time);
  }

  for (const time of [
    ' 8:05',
    '8:5',
    '24:00',
    '20:60',
    '20:15:60',
    '2026-07-18T19:31:59',
    '2026-07-18 19:31:59Z',
    '2026-02-29T00:00:00Z',
    '2026-07-18T19:31:59+24:00',
  ]) {
    const snapshot = sampleSnapshot();
    snapshot.logs[0].time = time;
    assert.throws(
      () => validatePersonalSnapshot(snapshot),
      (error: any) => error?.code === 'VALIDATION_FAILED',
    );
  }
});

test('personal snapshot enforces the same wire string boundaries as the client', () => {
  const maximum: any = sampleSnapshot();
  maximum.sessions[0].session_id = `s${'a'.repeat(127)}`;
  maximum.sessions[0].title = 't'.repeat(500);
  maximum.logs[0].session_id = maximum.sessions[0].session_id;
  maximum.logs[0].sync_id = `l${'b'.repeat(127)}`;
  maximum.logs[0].controller = 'c'.repeat(32);
  maximum.logs[0].callsign = 'x'.repeat(32);
  maximum.logs[0].rst_sent = 's'.repeat(16);
  maximum.logs[0].rst_rcvd = 'r'.repeat(16);
  maximum.logs[0].qth = 'q'.repeat(200);
  maximum.logs[0].device = 'd'.repeat(200);
  maximum.logs[0].power = 'p'.repeat(64);
  maximum.logs[0].antenna = 'a'.repeat(200);
  maximum.logs[0].height = 'h'.repeat(64);
  maximum.logs[0].remarks = 'm'.repeat(2_000);
  maximum.logs[0].source_device_id = 'i'.repeat(128);
  assert.equal(validatePersonalSnapshot(maximum).snapshot.logs[0].time, maximum.logs[0].time);

  const emptyOptional: any = sampleSnapshot();
  for (const field of [
    'rst_sent',
    'rst_rcvd',
    'qth',
    'device',
    'power',
    'antenna',
    'height',
    'remarks',
  ]) {
    emptyOptional.logs[0][field] = '';
  }
  emptyOptional.logs[0].source_device_id = null;
  assert.equal(validatePersonalSnapshot(emptyOptional).snapshot.logs[0].source_device_id, null);

  const invalidCases: Array<(snapshot: any) => void> = [
    (snapshot) => { snapshot.sessions[0].session_id = ''; },
    (snapshot) => { snapshot.sessions[0].session_id = 'bad id'; },
    (snapshot) => { snapshot.sessions[0].session_id = `s${'a'.repeat(128)}`; },
    (snapshot) => { snapshot.sessions[0].title = ''; },
    (snapshot) => { snapshot.sessions[0].title = 't'.repeat(501); },
    (snapshot) => { snapshot.logs[0].sync_id = '_invalid-first-character'; },
    (snapshot) => { snapshot.logs[0].sync_id = `l${'b'.repeat(128)}`; },
    (snapshot) => { snapshot.logs[0].controller = ''; },
    (snapshot) => { snapshot.logs[0].controller = 'c'.repeat(33); },
    (snapshot) => { snapshot.logs[0].callsign = ''; },
    (snapshot) => { snapshot.logs[0].callsign = 'x'.repeat(33); },
    (snapshot) => { snapshot.logs[0].rst_sent = 's'.repeat(17); },
    (snapshot) => { snapshot.logs[0].rst_rcvd = 'r'.repeat(17); },
    (snapshot) => { snapshot.logs[0].qth = 'q'.repeat(201); },
    (snapshot) => { snapshot.logs[0].device = 'd'.repeat(201); },
    (snapshot) => { snapshot.logs[0].power = 'p'.repeat(65); },
    (snapshot) => { snapshot.logs[0].antenna = 'a'.repeat(201); },
    (snapshot) => { snapshot.logs[0].height = 'h'.repeat(65); },
    (snapshot) => { snapshot.logs[0].remarks = 'm'.repeat(2_001); },
    (snapshot) => { snapshot.logs[0].source_device_id = ''; },
    (snapshot) => { snapshot.logs[0].source_device_id = 'i'.repeat(129); },
    (snapshot) => { snapshot.exportedAt = '2026-07-18T12:01:02'; },
    (snapshot) => { snapshot.sessions[0].created_at = '2026-07-18 19:30:00Z'; },
  ];
  for (const mutate of invalidCases) {
    const invalid: any = sampleSnapshot();
    mutate(invalid);
    assert.throws(
      () => validatePersonalSnapshot(invalid),
      (error: any) => error?.code === 'VALIDATION_FAILED',
    );
  }
});

describe('account personal cloud snapshot v1', () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let ownerToken: string;
  let otherToken: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-personal-snapshot-'));
    db = openDatabase(join(directory, 'test.db'));
    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'unused-hash', 'user', ?, ?)
    `);
    insertUser.run(OWNER_ID, 'snapshot-owner', NOW, NOW);
    insertUser.run(OTHER_ID, 'snapshot-other', NOW, NOW);
    db.prepare(`
      INSERT INTO sessions (id, title, status, owner_user_id, created_at, updated_at)
      VALUES ('shared-session', 'Shared net', 'active', ?, ?, ?)
    `).run(OWNER_ID, NOW, NOW);
    db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES ('shared-membership', 'shared-session', ?, 'owner', 1, ?, ?)
    `).run(OWNER_ID, NOW, NOW);
    ownerToken = accessToken(OWNER_ID);
    otherToken = accessToken(OTHER_ID);
    server = createServer(createApp({
      db,
      config: {
        jwtSecret: JWT_SECRET,
        jwtIssuer: JWT_ISSUER,
        rateLimitEnabled: false,
        environment: 'test',
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function request(
    path: string,
    options: {
      method?: string;
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  }

  function assertError(result: HttpResult, status: number, code: string): void {
    assert.equal(result.status, status);
    assert.equal(result.body?.error?.code, code);
    assert.equal(typeof result.body?.error?.requestId, 'string');
  }

  test('requires authentication and reports an explicit empty revision zero', async () => {
    assertError(await request('/api/v1/account/personal-snapshot'), 401, 'AUTH_REQUIRED');
    const result = await request('/api/v1/account/personal-snapshot', {
      token: ownerToken,
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('etag'), '"0"');
    assert.deepEqual(result.body.personalSnapshot, {
      exists: false,
      revision: 0,
      formatVersion: 1,
      sessionCount: 0,
      logCount: 0,
      byteSize: 0,
      checksum: null,
      createdAt: null,
      updatedAt: null,
    });
    assertError(
      await request('/api/v1/account/personal-snapshot/download', { token: ownerToken }),
      404,
      'PERSONAL_SNAPSHOT_NOT_FOUND',
    );
    assertError(
      await request('/api/v1/account/personal-snapshot/database-backup-v7', {
        token: ownerToken,
      }),
      422,
      'PERSONAL_SNAPSHOT_SESSION_REQUIRED',
    );
    assertError(
      await request(
        '/api/v1/account/personal-snapshot/sessions/missing-session/database-backup-v7',
        { token: ownerToken },
      ),
      404,
      'PERSONAL_SNAPSHOT_NOT_FOUND',
    );
  });

  test('requires both optimistic concurrency and an explicit dangerous confirmation', async () => {
    const snapshot = sampleSnapshot();
    assertError(
      await request('/api/v1/account/personal-snapshot', {
        method: 'PUT', token: ownerToken, body: { confirmation: 'REPLACE_PERSONAL_CLOUD_SNAPSHOT', snapshot },
      }),
      428,
      'PERSONAL_SNAPSHOT_REVISION_REQUIRED',
    );
    assertError(
      await request('/api/v1/account/personal-snapshot', {
        method: 'PUT', token: ownerToken, body: { expectedRevision: 0, snapshot },
      }),
      422,
      'PERSONAL_SNAPSHOT_REPLACE_CONFIRMATION_REQUIRED',
    );
  });

  test('atomically stores and downloads a lossless personal-only snapshot', async () => {
    const beforeSessions = Number(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get());
    const beforeLogs = Number(db.prepare('SELECT COUNT(*) FROM logs').pluck().get());
    const snapshot = sampleSnapshot();
    const result = await request('/api/v1/account/personal-snapshot', {
      method: 'PUT',
      token: ownerToken,
      headers: { 'if-match': '"0"' },
      body: {
        confirmation: 'REPLACE_PERSONAL_CLOUD_SNAPSHOT',
        snapshot,
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.replaced, true);
    assert.equal(result.body.personalSnapshot.revision, 1);
    assert.equal(result.body.personalSnapshot.sessionCount, 1);
    assert.equal(result.body.personalSnapshot.logCount, 1);
    assert.match(result.body.personalSnapshot.checksum, /^[0-9a-f]{64}$/);
    assert.equal(result.headers.get('etag'), '"1"');
    assert.equal(Number(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()), beforeSessions);
    assert.equal(Number(db.prepare('SELECT COUNT(*) FROM logs').pluck().get()), beforeLogs);

    const download = await request('/api/v1/account/personal-snapshot/download', {
      token: ownerToken,
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('etag'), '"1"');
    assert.match(
      download.headers.get('content-disposition') ?? '',
      /openlogtool-personal-snapshot-r1\.json/,
    );
    assert.deepEqual(download.body.personalSnapshot.snapshot, snapshot);

    const databaseBackup = await request(
      '/api/v1/account/personal-snapshot/sessions/local-session-2026-07-18/database-backup-v7',
      { token: ownerToken },
    );
    assert.equal(databaseBackup.status, 200);
    assert.match(
      databaseBackup.headers.get('content-disposition') ?? '',
      /openlogtool-session-local-session-2026-07-18-r1-v7\.json/,
    );
    assert.equal(databaseBackup.headers.get('x-openlogtool-backup-format-version'), '7');
    assert.equal(databaseBackup.headers.get('x-personal-snapshot-revision'), '1');
    assert.equal(
      databaseBackup.headers.get('x-personal-snapshot-session-id'),
      'local-session-2026-07-18',
    );
    assert.equal(databaseBackup.body.version, 7);
    assert.ok(Number.isFinite(Date.parse(databaseBackup.body.exportedAt)));
    assert.deepEqual(databaseBackup.body.sessions, snapshot.sessions);
    assert.deepEqual(databaseBackup.body.logs, snapshot.logs);
    for (const table of [
      'dictionary_items',
      'settings',
      'oplog',
      'collaboration_bindings',
      'entity_shadows',
      'sync_outbox',
      'applied_events',
      'sync_conflicts',
      'collaboration_live_drafts',
      'collaboration_offline_records',
    ]) {
      assert.deepEqual(databaseBackup.body[table], [], `${table} must be an empty v7 table`);
    }
    assertError(
      await request(
        '/api/v1/account/personal-snapshot/sessions/not-in-snapshot/database-backup-v7',
        { token: ownerToken },
      ),
      404,
      'PERSONAL_SNAPSHOT_SESSION_NOT_FOUND',
    );
  });

  test('unifies account collaboration and personal sessions with read-only personal details', async () => {
    const catalog = await request('/api/v1/account/session-catalog', {
      token: ownerToken,
    });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.total, 2);
    assert.deepEqual(
      catalog.body.items.map((item: any) => [item.source, item.sessionId, item.role]),
      [
        ['personal', 'local-session-2026-07-18', null],
        ['collaboration', 'shared-session', 'owner'],
      ],
    );

    const detail = await request(
      '/api/v1/account/personal-snapshot/sessions/local-session-2026-07-18',
      { token: ownerToken },
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.session.source, 'personal');
    assert.equal(detail.body.session.status, 'closed');
    assert.deepEqual(detail.body.counts, { logs: 1, deletedLogs: 0 });

    const logs = await request(
      '/api/v1/account/personal-snapshot/sessions/local-session-2026-07-18/logs?q=BG5CRL&sort=timeDesc',
      { token: ownerToken },
    );
    assert.equal(logs.status, 200);
    assert.equal(logs.body.total, 1);
    assert.equal(logs.body.items[0].callsign, 'BG5CRL');
    assert.equal(logs.body.items[0].canMutate, false);

    const otherCatalog = await request('/api/v1/account/session-catalog', {
      token: otherToken,
    });
    assert.equal(otherCatalog.status, 200);
    assert.equal(otherCatalog.body.total, 0);
    assertError(
      await request(
        '/api/v1/account/personal-snapshot/sessions/local-session-2026-07-18',
        { token: otherToken },
      ),
      404,
      'PERSONAL_SNAPSHOT_NOT_FOUND',
    );
  });

  test('keeps account-wide dictionary data out of a Session export', async () => {
    const dictionary = {
      version: 1,
      exportedAt: '2026-07-18T12:34:56.789+08:00',
      items: [
        {
          dictType: 'callsign',
          raw: 'BG5CLOUD',
          origin: 'user',
          state: 'active',
          pinyin: null,
          abbreviation: 'BC',
        },
        {
          dictType: 'antenna',
          raw: 'Legacy antenna',
          origin: 'builtin',
          state: 'deleted',
          pinyin: null,
          abbreviation: null,
        },
      ],
    };
    const uploaded = await request('/api/v1/account/personal-dictionary-snapshot', {
      method: 'PUT',
      token: ownerToken,
      body: {
        expectedRevision: 0,
        confirmation: 'REPLACE_PERSONAL_DICTIONARY_SNAPSHOT',
        snapshot: dictionary,
      },
    });
    assert.equal(uploaded.status, 200);

    const exported = await request(
      '/api/v1/account/personal-snapshot/sessions/local-session-2026-07-18/database-backup-v7',
      { token: ownerToken },
    );
    assert.equal(exported.status, 200);
    assert.match(
      exported.headers.get('content-disposition') ?? '',
      /openlogtool-session-local-session-2026-07-18-r1-v7\.json/,
    );
    assert.deepEqual(exported.body.dictionary_items, []);
    assert.deepEqual(exported.body.collaboration_bindings, []);
    assert.deepEqual(exported.body.sync_outbox, []);

    db.prepare(`
      UPDATE personal_dictionary_snapshots
      SET byte_size = byte_size + 1
      WHERE user_id = ?
    `).run(OWNER_ID);
    const exportWithCorruptDictionary = await request(
      '/api/v1/account/personal-snapshot/sessions/local-session-2026-07-18/database-backup-v7',
      {
        token: ownerToken,
      },
    );
    assert.equal(exportWithCorruptDictionary.status, 200);
    assert.deepEqual(exportWithCorruptDictionary.body.dictionary_items, []);
    db.prepare(`
      UPDATE personal_dictionary_snapshots
      SET byte_size = byte_size - 1
      WHERE user_id = ?
    `).run(OWNER_ID);
  });

  test('isolates snapshots by account and rejects stale destructive replacement', async () => {
    const other = await request('/api/v1/account/personal-snapshot', { token: otherToken });
    assert.equal(other.status, 200);
    assert.equal(other.body.personalSnapshot.exists, false);

    const changed = sampleSnapshot();
    changed.logs[0].callsign = 'BG5NEW';
    const stale = await request('/api/v1/account/personal-snapshot', {
      method: 'PUT',
      token: ownerToken,
      body: {
        expectedRevision: 0,
        confirmation: 'REPLACE_PERSONAL_CLOUD_SNAPSHOT',
        snapshot: changed,
      },
    });
    assertError(stale, 409, 'PERSONAL_SNAPSHOT_REVISION_CONFLICT');
    assert.equal(stale.body.error.details.currentRevision, 1);
    assert.match(stale.body.error.details.currentChecksum, /^[0-9a-f]{64}$/);
  });

  test('does not advance revision when only exportedAt changes', async () => {
    const sameContent = sampleSnapshot('2026-07-18T13:59:59.999Z');
    const result = await request('/api/v1/account/personal-snapshot', {
      method: 'PUT',
      token: ownerToken,
      body: {
        expectedRevision: 1,
        confirmation: 'REPLACE_PERSONAL_CLOUD_SNAPSHOT',
        snapshot: sameContent,
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.replaced, false);
    assert.equal(result.body.personalSnapshot.revision, 1);
    const downloaded = await request('/api/v1/account/personal-snapshot/download', {
      token: ownerToken,
    });
    assert.equal(downloaded.body.personalSnapshot.snapshot.exportedAt, sampleSnapshot().exportedAt);
  });

  test('strictly rejects collaboration/local-only fields and broken references', async () => {
    const withShareCode: any = sampleSnapshot();
    withShareCode.sessions[0].share_code = 'legacy-share';
    assertError(
      await request('/api/v1/account/personal-snapshot', {
        method: 'PUT', token: ownerToken,
        body: { expectedRevision: 1, confirmation: 'REPLACE_PERSONAL_CLOUD_SNAPSHOT', snapshot: withShareCode },
      }),
      422,
      'VALIDATION_FAILED',
    );
    const withLocalId: any = sampleSnapshot();
    withLocalId.logs[0].id = 42;
    assertError(
      await request('/api/v1/account/personal-snapshot', {
        method: 'PUT', token: ownerToken,
        body: { expectedRevision: 1, confirmation: 'REPLACE_PERSONAL_CLOUD_SNAPSHOT', snapshot: withLocalId },
      }),
      422,
      'VALIDATION_FAILED',
    );
    const orphan: any = sampleSnapshot();
    orphan.logs[0].session_id = 'missing-session';
    assertError(
      await request('/api/v1/account/personal-snapshot', {
        method: 'PUT', token: ownerToken,
        body: { expectedRevision: 1, confirmation: 'REPLACE_PERSONAL_CLOUD_SNAPSHOT', snapshot: orphan },
      }),
      422,
      'VALIDATION_FAILED',
    );
  });

  test('replaces an existing snapshot with matching If-Match and increments revision', async () => {
    const changed = sampleSnapshot('2026-07-18T14:00:00.000Z');
    changed.logs[0].callsign = 'BG5NEW';
    const result = await request('/api/v1/account/personal-snapshot', {
      method: 'PUT',
      token: ownerToken,
      headers: { 'if-match': '"1"' },
      body: {
        expectedRevision: 1,
        confirmation: 'REPLACE_PERSONAL_CLOUD_SNAPSHOT',
        snapshot: changed,
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.replaced, true);
    assert.equal(result.body.personalSnapshot.revision, 2);
    assert.equal(result.headers.get('etag'), '"2"');
  });

  test('enabled replacement limiter is scoped by account and can be disabled in tests', async () => {
    const limitedServer = createServer(createApp({
      db,
      config: {
        jwtSecret: JWT_SECRET,
        jwtIssuer: JWT_ISSUER,
        rateLimitEnabled: true,
        environment: 'test',
      },
    }));
    await new Promise<void>((resolve) => limitedServer.listen(0, '127.0.0.1', resolve));
    try {
      const address = limitedServer.address() as AddressInfo;
      const limitedBaseUrl = `http://127.0.0.1:${address.port}`;
      const limitedRequest = async (token: string) => {
        const response = await fetch(`${limitedBaseUrl}/api/v1/account/personal-snapshot`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            confirmation: 'REPLACE_PERSONAL_CLOUD_SNAPSHOT',
            snapshot: sampleSnapshot(),
          }),
        });
        const body = await response.json() as any;
        return { response, body };
      };

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const result = await limitedRequest(ownerToken);
        assert.equal(result.response.status, 428);
        assert.equal(result.response.headers.get('ratelimit-limit'), '12');
      }
      const limited = await limitedRequest(ownerToken);
      assert.equal(limited.response.status, 429);
      assert.equal(limited.body.error.code, 'RATE_LIMITED');
      assert.notEqual(limited.response.headers.get('retry-after'), null);

      const otherAccount = await limitedRequest(otherToken);
      assert.equal(otherAccount.response.status, 428);
    } finally {
      await new Promise<void>((resolve, reject) =>
        limitedServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});
