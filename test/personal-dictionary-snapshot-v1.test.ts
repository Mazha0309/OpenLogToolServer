import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';
import {
  type PersonalDictionarySnapshot,
  validatePersonalDictionarySnapshot,
} from '../src/personal-dictionary-snapshot/model';

type JsonObject = Record<string, any>;

const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'personal-dictionary-test-jwt-secret-e11a7d40-ef35-4600-a8ad',
  jwtIssuer: 'personal-dictionary-test',
  bootstrapSecret: 'personal-dictionary-test-bootstrap-secret',
  inviteHmacKey: 'personal-dictionary-test-invite-hmac-key',
  publicShareHmacKey: 'personal-dictionary-test-public-share-key',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

function fixture(suffix = ''): PersonalDictionarySnapshot {
  return {
    version: 1,
    exportedAt: '2026-07-19T01:02:03.456+08:00',
    items: [
      {
        dictType: 'callsign',
        raw: `BG5AAA${suffix}`,
        origin: 'user',
        state: 'active',
        pinyin: null,
        abbreviation: null,
      },
      {
        dictType: 'qth',
        raw: `杭州${suffix}`,
        origin: 'user',
        state: 'active',
        pinyin: 'hang zhou',
        abbreviation: 'hz',
      },
      {
        dictType: 'device',
        raw: `Builtin radio${suffix}`,
        origin: 'builtin',
        state: 'deleted',
        pinyin: null,
        abbreviation: null,
      },
    ],
  };
}

function token(userId: string, role: 'admin' | 'user'): string {
  return jwt.sign(
    { type: 'access', role },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      subject: userId,
      jwtid: randomUUID(),
      issuer: config.jwtIssuer,
      audience: 'openlogtool-v1',
      expiresIn: 300,
    },
  );
}

describe('personal dictionary snapshot v1', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;

  async function request(
    path: string,
    options: {
      method?: string;
      token?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
  ) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method,
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) as JsonObject : {},
      text,
    };
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-personal-dictionaries-'));
    const databasePath = join(directory, 'server.db');
    db = openDatabase(databasePath);
    config.dbPath = databasePath;
    const now = new Date().toISOString();
    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'NOT_EXPOSED', ?, ?, ?)
    `);
    insertUser.run('owner', 'owner', 'user', now, now);
    insertUser.run('other', 'other', 'user', now, now);
    insertUser.run('admin', 'admin', 'admin', now, now);
    const app = createApp({ db, config });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('model checksum ignores export time and ordering and rejects unsafe shapes', () => {
    const first = validatePersonalDictionarySnapshot(fixture());
    const reordered = fixture();
    reordered.exportedAt = '2026-07-20T02:03:04.000Z';
    reordered.items.reverse();
    assert.equal(validatePersonalDictionarySnapshot(reordered).checksum, first.checksum);
    assert.equal(first.itemCount, 3);
    assert.equal(first.activeCount, 2);
    assert.equal(first.deletedCount, 1);

    const duplicate = fixture();
    duplicate.items.push({ ...duplicate.items[0] });
    assert.throws(() => validatePersonalDictionarySnapshot(duplicate));
    const activeBuiltin = fixture();
    activeBuiltin.items[0].origin = 'builtin';
    assert.throws(() => validatePersonalDictionarySnapshot(activeBuiltin));
    const deletedSearchData = fixture();
    deletedSearchData.items[2].pinyin = 'must-not-survive';
    assert.throws(() => validatePersonalDictionarySnapshot(deletedSearchData));
    assert.throws(() => validatePersonalDictionarySnapshot({ ...fixture(), extra: true }));
  });

  test('advertises an independent feature and starts with revision zero', async () => {
    const info = await request('/api/v1/server-info');
    assert.equal(info.status, 200, info.text);
    assert.ok((info.body.features as string[]).includes('personalDictionarySnapshots'));

    const unauthorized = await request('/api/v1/account/personal-dictionary-snapshot');
    assert.equal(unauthorized.status, 401);
    const empty = await request('/api/v1/account/personal-dictionary-snapshot', {
      token: token('owner', 'user'),
    });
    assert.equal(empty.status, 200, empty.text);
    assert.equal(empty.headers.get('etag'), '"0"');
    assert.deepEqual(empty.body.personalDictionarySnapshot, {
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
    });
  });

  test('enforces confirmation and CAS, keeps accounts isolated, and accepts exact retries', async () => {
    const ownerToken = token('owner', 'user');
    const missingGuard = await request('/api/v1/account/personal-dictionary-snapshot', {
      method: 'PUT',
      token: ownerToken,
      body: { confirmation: 'REPLACE_PERSONAL_DICTIONARY_SNAPSHOT', snapshot: fixture() },
    });
    assert.equal(missingGuard.status, 428, missingGuard.text);
    const missingConfirmation = await request('/api/v1/account/personal-dictionary-snapshot', {
      method: 'PUT',
      token: ownerToken,
      body: { expectedRevision: 0, snapshot: fixture() },
    });
    assert.equal(missingConfirmation.status, 422, missingConfirmation.text);

    const created = await request('/api/v1/account/personal-dictionary-snapshot', {
      method: 'PUT',
      token: ownerToken,
      headers: { 'if-match': '"0"' },
      body: {
        expectedRevision: 0,
        confirmation: 'REPLACE_PERSONAL_DICTIONARY_SNAPSHOT',
        snapshot: fixture(),
      },
    });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.replaced, true);
    assert.equal(created.body.personalDictionarySnapshot.revision, 1);

    const sameContent = fixture();
    sameContent.exportedAt = '2026-07-21T00:00:00.000Z';
    sameContent.items.reverse();
    const retry = await request('/api/v1/account/personal-dictionary-snapshot', {
      method: 'PUT',
      token: ownerToken,
      body: {
        expectedRevision: 1,
        confirmation: 'REPLACE_PERSONAL_DICTIONARY_SNAPSHOT',
        snapshot: sameContent,
      },
    });
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.body.replaced, false);
    assert.equal(retry.body.personalDictionarySnapshot.revision, 1);

    const stale = await request('/api/v1/account/personal-dictionary-snapshot', {
      method: 'PUT',
      token: ownerToken,
      body: {
        expectedRevision: 0,
        confirmation: 'REPLACE_PERSONAL_DICTIONARY_SNAPSHOT',
        snapshot: fixture('-stale'),
      },
    });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.error.code, 'PERSONAL_DICTIONARY_SNAPSHOT_REVISION_CONFLICT');

    const download = await request('/api/v1/account/personal-dictionary-snapshot/download', {
      token: ownerToken,
    });
    assert.equal(download.status, 200, download.text);
    assert.equal(download.headers.get('etag'), '"1"');
    assert.deepEqual(download.body.personalDictionarySnapshot.snapshot, fixture());
    const other = await request('/api/v1/account/personal-dictionary-snapshot', {
      token: token('other', 'user'),
    });
    assert.equal(other.body.personalDictionarySnapshot.exists, false);
  });

  test('administrator list stays metadata-only and detail is integrity checked and audited', async () => {
    const adminToken = token('admin', 'admin');
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run('ÉchoOwner', 'owner');
    const unicodeSearch = await request(
      `/api/v1/admin/personal-dictionary-snapshots?q=${encodeURIComponent('e\u0301CHOOWNER')}`,
      { token: adminToken },
    );
    assert.equal(unicodeSearch.status, 200, unicodeSearch.text);
    assert.equal(unicodeSearch.body.total, 1);
    assert.equal(unicodeSearch.body.items[0].user.id, 'owner');

    const list = await request('/api/v1/admin/personal-dictionary-snapshots', {
      token: adminToken,
    });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].user.id, 'owner');
    assert.equal(list.body.items[0].personalDictionarySnapshot.itemCount, 3);
    assert.equal(list.text.includes('BG5AAA'), false);

    const accessId = `dictionary-read-${randomUUID()}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const detail = await request('/api/v1/admin/personal-dictionary-snapshots/owner', {
        token: adminToken,
        headers: { 'x-admin-access-id': accessId },
      });
      assert.equal(detail.status, 200, detail.text);
      assert.deepEqual(detail.body.personalDictionarySnapshot.snapshot, fixture());
    }
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) FROM admin_governance_audit_events
      WHERE action = 'personal_dictionary_snapshot.detail.viewed'
        AND target_id = 'owner'
    `).pluck().get()), 1);

    db.prepare(`
      UPDATE personal_dictionary_snapshots SET byte_size = byte_size + 1
      WHERE user_id = 'owner'
    `).run();
    const corrupt = await request('/api/v1/admin/personal-dictionary-snapshots/owner', {
      token: adminToken,
      headers: { 'x-admin-access-id': `corrupt-${randomUUID()}` },
    });
    assert.equal(corrupt.status, 500, corrupt.text);
    assert.equal(corrupt.body.error.code, 'PERSONAL_DICTIONARY_SNAPSHOT_CORRUPT');
  });
});
