// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://example.test/BR5AI" }
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act, createElement } from 'react';
import App, { ArchiveApp } from '../src/App.tsx';

const directory = {
  id: 'list-1',
  title: 'BR5AI activity archive',
  sessions: [{
    id: 'archive-1', title: 'June net', closedAt: '2026-06-01T12:00:00.000Z', displayOrder: 0, logCount: 2,
  }],
};

const detail = {
  session: directory.sessions[0],
  logs: [
    { ordinal: 1, time: '2026-06-01T10:00:00.000Z', controller: 'BA1AA', callsign: 'EARLY', rstSent: null, rstRcvd: null, qth: null, device: null, power: null, antenna: null, height: null, remarks: null },
    { ordinal: 8, time: '2026-06-01T12:00:00.000Z', controller: 'BA1BB', callsign: 'LATEST', rstSent: null, rstRcvd: null, qth: null, device: null, power: null, antenna: null, height: null, remarks: null },
  ],
};

async function renderArchive(route: Parameters<typeof ArchiveApp>[0]['route'], response: unknown) {
  return renderComponent(createElement(ArchiveApp, { route }), response);
}

async function renderApp(pathname: string, response: unknown) {
  window.history.replaceState(null, '', pathname);
  return renderComponent(createElement(App), response);
}

async function renderComponent(component: ReturnType<typeof createElement>, response: unknown) {
  document.body.innerHTML = '<div id="root"></div>';
  const calls: string[] = [];
  let webSocketCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ data: response }), { status: 200 });
  };
  globalThis.WebSocket = class { constructor() { webSocketCalls += 1; } } as never;
  const root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(component); });
  await act(async () => { await Promise.resolve(); });

  return {
    calls,
    get webSocketCalls() { return webSocketCalls; },
    html: () => document.body.innerHTML,
    cleanup: async () => {
      await act(async () => { root.unmount(); });
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
    },
  };
}

test('ArchiveApp renders an alias directory through only the anonymous archive API', async () => {
  const view = await renderArchive({ kind: 'list', alias: 'BR5AI' }, directory);
  try {
    assert.match(view.html(), /BR5AI activity archive/);
    assert.match(view.html(), /June net/);
    assert.match(view.html(), /2026/);
    assert.match(view.html(), /2 archived records/);
    assert.match(view.html(), /href="\/BR5AI\/session\/archive-1"/);
    assert.deepEqual(view.calls, ['/api/v1/public/archive-aliases/BR5AI']);
    assert.equal(view.webSocketCalls, 0);
    assert.ok(view.calls.every((url) => !/exchange|snapshot|ticket/i.test(url)));
  } finally {
    await view.cleanup();
  }
});

test('ArchiveApp renders alias detail newest-first with stable ordinals and anonymous footer', async () => {
  const view = await renderArchive({ kind: 'session', alias: 'BR5AI', archiveSessionId: 'archive-1' }, detail);
  try {
    const html = view.html();
    assert.match(html, /href="\/BR5AI"/);
    assert.match(html, /June net/);
    assert.match(html, /2 archived records/);
    assert.match(html, /2026/);
    assert.ok(html.indexOf('LATEST') < html.indexOf('EARLY'));
    assert.match(html, /#8/);
    assert.match(html, /anonymous access/i);
    assert.deepEqual(view.calls, ['/api/v1/public/archive-aliases/BR5AI/sessions/archive-1']);
    assert.equal(view.webSocketCalls, 0);
    assert.ok(view.calls.every((url) => !/exchange|snapshot|ticket/i.test(url)));
  } finally {
    await view.cleanup();
  }
});

test('default App renders an internal archive directory without LiveShare capability calls', async () => {
  const view = await renderApp('/live/list/list-1', directory);
  try {
    const html = view.html();
    assert.match(html, /BR5AI activity archive/);
    assert.match(html, /June net/);
    assert.match(html, /href="\/live\/list\/list-1\/session\/archive-1"/);
    assert.deepEqual(view.calls, ['/api/v1/public/archive-lists/list-1']);
    assert.equal(view.webSocketCalls, 0);
    assert.ok(view.calls.every((url) => !/exchange|snapshot|ticket/i.test(url)));
  } finally {
    await view.cleanup();
  }
});

test('default App renders an internal archive detail without LiveShare capability calls', async () => {
  const view = await renderApp('/live/list/list-1/session/archive-1', detail);
  try {
    const html = view.html();
    assert.match(html, /href="\/live\/list\/list-1"/);
    assert.match(html, /June net/);
    assert.match(html, /2 archived records/);
    assert.ok(html.indexOf('LATEST') < html.indexOf('EARLY'));
    assert.match(html, /#8/);
    assert.deepEqual(view.calls, ['/api/v1/public/archive-lists/list-1/sessions/archive-1']);
    assert.equal(view.webSocketCalls, 0);
    assert.ok(view.calls.every((url) => !/exchange|snapshot|ticket/i.test(url)));
  } finally {
    await view.cleanup();
  }
});
