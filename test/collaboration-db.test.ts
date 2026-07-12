import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../src/db/database';

const NOW = '2026-07-11T08:00:00.000Z';
const LATER = '2026-07-12T08:00:00.000Z';

async function withTemporaryPath(
  prefix: string,
  run: (databasePath: string) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(join(directory, 'test.db'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('migration v4 backfills every legacy session owner exactly once', async () => {
  await withTemporaryPath('openlogtool-membership-backfill-', (databasePath) => {
    const legacy = new Database(databasePath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE server_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        registration_enabled INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO server_settings (id, registration_enabled) VALUES (1, 1);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE shares (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        code TEXT NOT NULL UNIQUE,
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );
    `);
    legacy.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'hash', 'user', ?, ?)
    `).run('legacy-owner', 'legacy-owner', NOW, NOW);
    legacy.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES ('legacy-admin', 'legacy-admin', 'hash', 'admin', ?, ?)
    `).run(NOW, NOW);
    legacy.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?, ?)
    `).run('legacy-session', 'Legacy session', 'legacy-owner', NOW, LATER);
    legacy.prepare(`
      INSERT INTO shares (
        id, session_id, code, owner_user_id, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
    `).run('legacy-share', 'legacy-session', 'OLD-CODE', 'legacy-owner', NOW);
    legacy.close();

    const db = openDatabase(databasePath);
    try {
      const member = db.prepare(`
        SELECT session_id, user_id, role, version, created_at, updated_at,
               removed_at, removed_by
        FROM session_members
        WHERE session_id = ?
      `).get('legacy-session') as Record<string, unknown> | undefined;
      assert.deepEqual(member, {
        session_id: 'legacy-session',
        user_id: 'legacy-owner',
        role: 'owner',
        version: 1,
        created_at: NOW,
        updated_at: LATER,
        removed_at: null,
        removed_by: null,
      });
      assert.equal(
        db.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('legacy-session'),
        'active',
        'the membership migration must not change existing session state',
      );
      assert.equal(
        db.prepare('SELECT name FROM schema_migrations WHERE version = 4').pluck().get(),
        'collaboration_access_and_idempotency',
      );
      assert.equal(
        db.prepare('SELECT name FROM schema_migrations WHERE version = 6').pluck().get(),
        'disable_legacy_collaboration_channels',
      );
      assert.ok(
        db.prepare('SELECT revoked_at FROM shares WHERE id = ?').pluck().get('legacy-share'),
        'legacy share credentials must be revoked during migration',
      );
      assert.throws(
        () =>
          db.prepare(`
            INSERT INTO shares (
              id, session_id, code, owner_user_id, created_at, expires_at, revoked_at
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
          `).run('new-legacy-share', 'legacy-session', 'NEW-CODE', 'legacy-owner', NOW),
        /legacy shares are disabled/,
      );

      const migrationCount = db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get();
      runMigrations(db);
      assert.equal(db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(), migrationCount);
      assert.equal(
        db.prepare('SELECT COUNT(*) FROM session_members WHERE session_id = ?').pluck().get(
          'legacy-session',
        ),
        1,
        'rerunning migrations must not duplicate backfilled owners',
      );
    } finally {
      db.close();
    }
  });
});

test('collaboration access tables enforce roles, use limits and idempotency keys', async () => {
  await withTemporaryPath('openlogtool-collaboration-constraints-', (databasePath) => {
    const db = openDatabase(databasePath);
    try {
      const insertUser = db.prepare(`
        INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
        VALUES (?, ?, 'hash', 'user', ?, ?)
      `);
      insertUser.run('owner-user', 'owner-user', NOW, NOW);
      insertUser.run('editor-user', 'editor-user', NOW, NOW);
      insertUser.run('other-user', 'other-user', NOW, NOW);
      db.prepare(`
        INSERT INTO sessions (
          id, title, status, owner_user_id, created_at, updated_at
        ) VALUES (?, ?, 'initializing', ?, ?, ?)
      `).run('session-1', 'Initializing session', 'owner-user', NOW, NOW);

      const insertMember = db.prepare(`
        INSERT INTO session_members (
          id, session_id, user_id, role, version, created_at, updated_at
        ) VALUES (?, 'session-1', ?, ?, 1, ?, ?)
      `);
      insertMember.run('member-owner', 'owner-user', 'owner', NOW, NOW);
      insertMember.run('member-editor', 'editor-user', 'editor', NOW, NOW);

      assert.throws(
        () => insertMember.run('member-duplicate', 'editor-user', 'viewer', NOW, NOW),
        /UNIQUE/i,
      );
      assert.throws(
        () => insertMember.run('member-invalid-role', 'other-user', 'admin', NOW, NOW),
        /CHECK/i,
      );
      assert.throws(
        () => insertMember.run('member-second-owner', 'other-user', 'owner', NOW, NOW),
        /UNIQUE/i,
      );

      const insertInvite = db.prepare(`
        INSERT INTO collaboration_invites (
          id, session_id, code_hash, link_token_hash, code_hint, role,
          max_uses, used_count, expires_at, created_by, created_at
        ) VALUES (?, 'session-1', ?, ?, ?, ?, ?, ?, ?, 'owner-user', ?)
      `);
      insertInvite.run(
        'invite-1',
        'code-hash-1',
        'link-hash-1',
        'ABCD',
        'editor',
        1,
        0,
        LATER,
        NOW,
      );
      insertInvite.run(
        'invite-2',
        'code-hash-2',
        'link-hash-2',
        'EFGH',
        'viewer',
        2,
        0,
        LATER,
        NOW,
      );

      assert.throws(
        () => insertInvite.run(
          'invite-owner-role',
          'code-hash-owner',
          null,
          'IJKL',
          'owner',
          1,
          0,
          LATER,
          NOW,
        ),
        /CHECK/i,
      );
      assert.throws(
        () => insertInvite.run(
          'invite-overused',
          'code-hash-overused',
          null,
          'MNOP',
          'editor',
          1,
          2,
          LATER,
          NOW,
        ),
        /CHECK/i,
      );
      assert.throws(
        () => insertInvite.run(
          'invite-duplicate-code',
          'code-hash-1',
          null,
          'QRST',
          'editor',
          1,
          0,
          LATER,
          NOW,
        ),
        /UNIQUE/i,
      );

      const insertRedemption = db.prepare(`
        INSERT INTO invite_redemptions (
          id, invite_id, user_id, membership_id, join_request_id,
          device_id, role_granted, redeemed_at
        ) VALUES (?, ?, 'editor-user', 'member-editor', ?, ?, ?, ?)
      `);
      insertRedemption.run(
        'redemption-1',
        'invite-1',
        'join-request-1',
        'device-1',
        'editor',
        NOW,
      );
      assert.throws(
        () => insertRedemption.run(
          'redemption-reused-request',
          'invite-2',
          'join-request-1',
          'device-1',
          'viewer',
          NOW,
        ),
        /UNIQUE/i,
      );
      assert.throws(
        () => insertRedemption.run(
          'redemption-reused-invite',
          'invite-1',
          'join-request-2',
          'device-1',
          'editor',
          NOW,
        ),
        /UNIQUE/i,
      );

      const insertMutation = db.prepare(`
        INSERT INTO processed_mutations (
          mutation_id, session_id, user_id, device_id, request_hash,
          status_code, response_json, created_at
        ) VALUES (?, ?, 'owner-user', ?, ?, ?, ?, ?)
      `);
      insertMutation.run(
        'mutation-1',
        'session-1',
        'device-1',
        'request-hash-1',
        201,
        '{"ok":true}',
        NOW,
      );
      assert.throws(
        () => insertMutation.run(
          'mutation-1',
          'session-1',
          'device-1',
          'request-hash-2',
          201,
          '{"ok":true}',
          NOW,
        ),
        /UNIQUE/i,
      );
      assert.throws(
        () => insertMutation.run(
          'mutation-bad-status',
          null,
          null,
          'request-hash-3',
          99,
          '{}',
          NOW,
        ),
        /CHECK/i,
      );

      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  });
});
