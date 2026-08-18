import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchArchive, parseArchiveRoute } from '../src/archive.ts';

const list = {
  id: 'list-1',
  title: 'Club archive',
  sessions: [{ id: 'archive-1', title: 'June net', closedAt: '2026-06-01T12:00:00.000Z', displayOrder: 0, logCount: 2 }],
};

test('parses internal list directory and detail routes without treating LiveShare IDs as archives', () => {
  assert.deepEqual(parseArchiveRoute('/live/list/list-1'), { kind: 'list', listId: 'list-1' });
  assert.deepEqual(parseArchiveRoute('/live/list/list-1/session/archive-1'), {
    kind: 'session', listId: 'list-1', archiveSessionId: 'archive-1',
  });
  assert.equal(parseArchiveRoute('/live/share-1'), null);
});

test('fetches an internal archive route only through anonymous archive endpoints', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ data: list }), { status: 200 });
  };

  try {
    const route = parseArchiveRoute('/live/list/list-1/session/archive-1');
    assert.ok(route);
    await fetchArchive(route);
    assert.deepEqual(calls, ['/api/v1/public/archive-lists/list-1/sessions/archive-1']);
    assert.ok(calls.every((url) => url.startsWith('/api/v1/public/archive-')));
    assert.ok(calls.every((url) => !/exchange|snapshot|ticket|ws/i.test(url)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetches root aliases and keeps alias route navigation independent of internal IDs', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ data: list }), { status: 200 });
  };

  try {
    const directory = parseArchiveRoute('/BR5AI');
    const detail = parseArchiveRoute('/BR5AI/session/archive-1');
    assert.deepEqual(directory, { kind: 'list', alias: 'BR5AI' });
    assert.deepEqual(detail, { kind: 'session', alias: 'BR5AI', archiveSessionId: 'archive-1' });
    assert.equal(parseArchiveRoute('/api'), null);
    assert.equal(parseArchiveRoute('/live'), null);

    await fetchArchive(directory!);
    await fetchArchive(detail!);
    assert.deepEqual(calls, [
      '/api/v1/public/archive-aliases/BR5AI',
      '/api/v1/public/archive-aliases/BR5AI/sessions/archive-1',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
