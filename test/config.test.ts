import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, validateRuntimeConfig } from '../src/config';

test('runtime configuration never accepts an implicit JWT secret', () => {
  const missing = loadConfig({ NODE_ENV: 'test' });
  assert.equal(missing.jwtSecret, '');
  assert.throws(() => validateRuntimeConfig(missing), /JWT_SECRET/);

  const configured = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'a'.repeat(32),
  });
  assert.doesNotThrow(() => validateRuntimeConfig(configured));
  assert.throws(
    () => validateRuntimeConfig(configured, { requireBootstrapSecret: true }),
    /ADMIN_BOOTSTRAP_TOKEN/,
  );
  assert.throws(
    () => validateRuntimeConfig(configured, { requireInviteHmacKey: true }),
    /INVITE_HMAC_KEY/,
  );

  const bootstrappable = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'a'.repeat(32),
    ADMIN_BOOTSTRAP_TOKEN: 'b'.repeat(24),
    INVITE_HMAC_KEY: 'c'.repeat(32),
  });
  assert.doesNotThrow(() =>
    validateRuntimeConfig(bootstrappable, {
      requireBootstrapSecret: true,
      requireInviteHmacKey: true,
    }),
  );
});
