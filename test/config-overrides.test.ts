import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { AppConfig } from '../src/config';
import { applyStoredConfigOverrides } from '../src/config-overrides';

function testConfig(containerMode: boolean): AppConfig {
  return {
    port: 3000,
    dbPath: ':memory:',
    jwtSecret: 'a'.repeat(32),
    jwtIssuer: 'openlogtool-test',
    bootstrapSecret: '',
    inviteHmacKey: 'b'.repeat(32),
    publicShareHmacKey: 'c'.repeat(32),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
    corsOrigins: [],
    trustProxy: false,
    jsonBodyLimit: '1mb',
    rateLimitEnabled: true,
    environment: 'test',
    containerMode,
  };
}

function overridesDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE server_config_overrides (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO server_config_overrides (key, value_json) VALUES (?, ?)
  `);
  insert.run('port', JSON.stringify(4321));
  insert.run('corsOrigins', JSON.stringify(['https://radio.example']));
  insert.run('accessTokenTtlSeconds', JSON.stringify(1200));
  return db;
}

test('container mode ignores a persisted port while applying all other overrides', () => {
  const db = overridesDatabase();
  try {
    const config = testConfig(true);

    applyStoredConfigOverrides(db, config);

    assert.equal(config.port, 3000);
    assert.deepEqual(config.corsOrigins, ['https://radio.example']);
    assert.equal(config.accessTokenTtlSeconds, 1200);
  } finally {
    db.close();
  }
});

test('non-container deployments continue to apply a persisted port override', () => {
  const db = overridesDatabase();
  try {
    const config = testConfig(false);

    applyStoredConfigOverrides(db, config);

    assert.equal(config.port, 4321);
    assert.deepEqual(config.corsOrigins, ['https://radio.example']);
    assert.equal(config.accessTokenTtlSeconds, 1200);
  } finally {
    db.close();
  }
});
