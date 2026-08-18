import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database';
import {
  normalizePublicArchiveAlias,
  publicArchiveListDto,
  publicArchiveLogDto,
  publicArchiveSessionDto,
} from '../src/public-archives/model';

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
