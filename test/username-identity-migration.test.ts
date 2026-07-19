import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/database';
import { runMigrations } from '../src/db/migrations';

function rollBackUsernameIdentityMigration(db: Database.Database): void {
  db.exec(`
    DROP INDEX idx_users_username_identity;
    DELETE FROM schema_migrations WHERE version IN (21, 22);
  `);
}

test('migration v21 normalizes display names and enforces Unicode case-insensitive identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-username-identity-'));
  let db: Database.Database | undefined;
  try {
    db = openDatabase(join(directory, 'identity.db'));
    rollBackUsernameIdentityMigration(db);
    const now = '2026-07-19T00:00:00.000Z';
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES ('unicode-user', ?, 'hash', 'user', ?, ?)
    `).run(`A\u0308lice`, now, now);

    runMigrations(db);

    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 21').get(),
      { version: 21, name: 'unicode_username_identity' },
    );
    assert.equal(
      db.prepare("SELECT username FROM users WHERE id = 'unicode-user'").pluck().get(),
      'Älice',
    );
    assert.throws(
      () => db!.prepare(`
        INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
        VALUES ('duplicate-user', 'äLICE', 'hash', 'user', ?, ?)
      `).run(now, now),
      /UNIQUE constraint failed/i,
    );
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('migration v21 refuses historical username identity collisions without partial changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-username-collision-'));
  let db: Database.Database | undefined;
  try {
    db = openDatabase(join(directory, 'collision.db'));
    rollBackUsernameIdentityMigration(db);
    const now = '2026-07-19T00:00:00.000Z';
    const insert = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'hash', 'user', ?, ?)
    `);
    insert.run('collision-a', 'Älice', now, now);
    insert.run('collision-b', `a\u0308LICE`, now, now);

    assert.throws(
      () => runMigrations(db!),
      /USERNAME_IDENTITY_COLLISION.*collision-a.*collision-b/i,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM schema_migrations WHERE version = 21').pluck().get(),
      0,
    );
    assert.equal(
      db.prepare("SELECT username FROM users WHERE id = 'collision-b'").pluck().get(),
      `a\u0308LICE`,
      'failed migration must roll back NFC display normalization',
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_username_identity'").pluck().get(),
      0,
    );
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
