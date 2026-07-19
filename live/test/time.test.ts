import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLogTime } from '../src/time.ts';

test('record time is always HH:mm regardless of stored seconds', () => {
  assert.equal(formatLogTime('9:05:07', 'zh-CN'), '09:05');
  assert.equal(formatLogTime('20:15:59', 'en-US'), '20:15');
  assert.equal(formatLogTime('20:15', 'zh-CN'), '20:15');
  assert.match(
    formatLogTime('2026-07-12T12:34:56.987Z', 'en-US'),
    /^\d{2}:\d{2}$/,
  );
  assert.equal(formatLogTime('legacy-value', 'zh-CN'), 'legacy-value');
});
