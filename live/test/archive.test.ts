import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ArchiveBreadcrumb,
  ArchiveSessionLink,
  fetchArchive,
  parseArchiveRoute,
  sortArchiveLogs,
} from '../src/archive.ts';
import { translate } from '../src/i18n.ts';

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
  const options: RequestInit[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    options.push(init ?? {});
    return new Response(JSON.stringify({ data: list }), { status: 200 });
  };

  try {
    const route = parseArchiveRoute('/live/list/list-1/session/archive-1');
    assert.ok(route);
    await fetchArchive(route);
    assert.deepEqual(calls, ['/api/v1/public/archive-lists/list-1/sessions/archive-1']);
    assert.ok(calls.every((url) => url.startsWith('/api/v1/public/archive-')));
    assert.ok(calls.every((url) => !/exchange|snapshot|ticket|ws/i.test(url)));
    assert.deepEqual(options, [{ credentials: 'omit' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetches root aliases and keeps alias route navigation independent of internal IDs', async () => {
  const calls: string[] = [];
  const options: RequestInit[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    options.push(init ?? {});
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
    assert.deepEqual(options, [{ credentials: 'omit' }, { credentials: 'omit' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sorts archive logs newest-first without changing stable ordinal labels or fetched input', () => {
  const logs = [
    { ordinal: 1, time: '2026-06-01T10:00:00.000Z', callsign: 'FIRST' },
    { ordinal: 3, time: '2026-06-01T12:00:00.000Z', callsign: 'LATEST' },
    { ordinal: 2, time: '2026-06-01T12:00:00.000Z', callsign: 'TIE' },
  ];

  const sorted = sortArchiveLogs(logs);

  assert.deepEqual(sorted.map((log) => [log.callsign, log.ordinal]), [
    ['TIE', 2], ['LATEST', 3], ['FIRST', 1],
  ]);
  assert.deepEqual(logs.map((log) => log.callsign), ['FIRST', 'LATEST', 'TIE']);
});

test('renders alias detail links and breadcrumbs without replacing the public alias', () => {
  const sessionLink = renderToStaticMarkup(createElement(ArchiveSessionLink, {
    route: { kind: 'list', alias: 'BR5AI' }, archiveSessionId: 'archive-1',
  }, 'June net'));
  const breadcrumb = renderToStaticMarkup(createElement(ArchiveBreadcrumb, {
    route: { kind: 'session', alias: 'BR5AI', archiveSessionId: 'archive-1' },
  }, 'June net'));

  assert.match(sessionLink, /href="\/BR5AI\/session\/archive-1"/);
  assert.match(breadcrumb, /href="\/BR5AI"/);
});

test('archive copy describes static anonymous records without LiveShare credentials', () => {
  const footer = translate('en-US', 'archiveFooter');

  assert.match(footer, /anonymous/i);
  assert.doesNotMatch(footer, /credential|capability|secure/i);
});
