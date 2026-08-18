# Public Archive Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add collaboratively managed, tokenless public archive lists for closed sessions, with static LiveShare-style reading pages, administrator root-path aliases, and retained LiveShare fragment tokens.

**Architecture:** Add a server archive domain that snapshots eligible closed personal or collaboration sessions into dedicated SQLite tables. Mount authenticated list-management and anonymous read routers in the existing Express app; serve archive aliases through the existing `live/` SPA bundle. Extend the authenticated WebUI for management and the `live/` React bundle with a non-WebSocket archive mode.

**Tech Stack:** TypeScript, Node.js, Express, better-sqlite3, React 19, Ant Design 6, React Router, Vite, Node test runner, Vitest.

---

## File Structure

- `src/db/migrations.ts`: migration 25 tables/indexes for archive lists and snapshots.
- `src/public-archives/model.ts`: archive DTOs, row mappers, alias validation, snapshot helpers.
- `src/public-archives/access.ts`: list-owner/member/admin authorization and source-account eligibility.
- `src/public-archives/service.ts`: transactional snapshot creation, refresh, ordering, publication, and deletion.
- `src/api/public-archive-lists-v1.ts`: authenticated list-management API.
- `src/api/admin-public-archive-lists-v1.ts`: administrator alias API.
- `src/api/public-archives-v1.ts`: anonymous tokenless read API.
- `src/app.ts`: mount routers and serve root aliases through `live/dist/index.html` before WebUI fallback.
- `test/public-archive-lists.test.ts`: server behavior, authorization, snapshot, public 404, and alias tests.
- `web/src/types.ts`, `web/src/api.ts`: authenticated archive-list types and API client methods.
- `web/src/pages/app/PublicArchiveListsPage.tsx`: owner/member list workspace.
- `web/src/pages/admin/PublicArchiveListsPage.tsx`: administrator list/alias controls.
- `web/src/App.tsx` and shell navigation files: member/admin routes and navigation entries.
- `live/src/archive.ts`, `live/src/types.ts`, `live/src/App.tsx`: static archive fetcher, route mode, directory and detail pages.
- `live/src/link.ts`: parse LiveShare fragment without removing it.
- `live/test/archive.test.ts`, `live/test/link.test.ts`: archive-route and retained-token tests.
- `README.md`, `web/README.md`, `live/README.md`, `docs/public-archive-lists-api-v1.md`, `deploy/nginx-openlogtool.conf.example`: shipped API and deployment documentation.

### Task 1: Database Schema and Domain Types

**Files:**
- Modify: `src/db/migrations.ts`
- Create: `src/public-archives/model.ts`
- Test: `test/public-archive-lists.test.ts`

- [ ] **Step 1: Write migration tests before implementation**

Add a test that opens a fresh database, runs migrations, then asserts these tables and indexes exist:

```ts
for (const table of [
  'public_archive_lists',
  'public_archive_list_members',
  'public_archive_list_sources',
  'public_archive_list_sessions',
  'public_archive_list_logs',
  'public_archive_aliases',
]) {
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
```

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `npm test -- test/public-archive-lists.test.ts`

Expected: FAIL because the tables do not exist.

- [ ] **Step 3: Add migration 25**

Append migration `25/public_archive_lists` in `src/db/migrations.ts`. Create the six tables described in [the approved design](/home/mazha0309/Projects/OpenLogToolServer/docs/superpowers/specs/2026-08-18-public-archive-lists-design.md), including:

```sql
CREATE INDEX idx_public_archive_list_sessions_list_order
ON public_archive_list_sessions(list_id, display_order, closed_at DESC);
CREATE INDEX idx_public_archive_list_logs_session_ordinal
ON public_archive_list_logs(archive_session_id, ordinal);
CREATE INDEX idx_public_archive_list_members_user
ON public_archive_list_members(user_id, list_id);
CREATE INDEX idx_public_archive_list_sources_user
ON public_archive_list_sources(user_id, list_id);
```

Use the existing `checksum(...)` convention and only append the migration.

- [ ] **Step 4: Add archive model and alias validation**

Create `src/public-archives/model.ts` with exported DTO types and these validation rules:

```ts
export const PUBLIC_ARCHIVE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
export const RESERVED_PUBLIC_ARCHIVE_ALIASES = new Set([
  'api', 'admin', 'app', 'assets', 'favicon.ico', 'health',
  'live', 'robots.txt', 'web', 'ws',
]);

export function normalizePublicArchiveAlias(value: string): string {
  const alias = value.trim().toLowerCase();
  if (!PUBLIC_ARCHIVE_ALIAS.test(alias) || RESERVED_PUBLIC_ARCHIVE_ALIASES.has(alias)) {
    throw new AppError(422, 'ARCHIVE_ALIAS_INVALID', 'Archive alias is invalid');
  }
  return alias;
}
```

Define `PublicArchiveListDto`, `PublicArchiveSessionDto`, `PublicArchiveLogDto`, and public row mappers. Keep snapshot DTOs free of source-account IDs and internal audit fields.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- test/public-archive-lists.test.ts`

Expected: PASS for schema and alias normalization cases.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations.ts src/public-archives/model.ts test/public-archive-lists.test.ts
git commit -m "feat: add public archive schema"
```

### Task 2: Archive Access and Immutable Snapshot Service

**Files:**
- Create: `src/public-archives/access.ts`
- Create: `src/public-archives/service.ts`
- Modify: `src/session-catalog/account-session-catalog.ts`
- Test: `test/public-archive-lists.test.ts`

- [ ] **Step 1: Write failing authorization and snapshot tests**

Cover these cases with real HTTP-independent service calls:

```ts
// Owner and member can manage contents; only owner/admin changes members/sources.
await assert.rejects(() => addArchiveSource(db, listId, memberId, otherUserId), {
  code: 'ARCHIVE_LIST_FORBIDDEN',
});

// An active, deleted, or unauthorized source session cannot be snapshotted.
await assert.rejects(() => createArchiveSnapshot(db, inputForActiveSession), {
  code: 'ARCHIVE_SESSION_NOT_CLOSED',
});

// A snapshot remains unchanged after source logs are edited or deleted.
const archive = createArchiveSnapshot(db, closedSessionInput);
editSourceLog(db, sourceSessionId);
assert.deepEqual(readArchiveLogs(db, archive.id), originalArchiveLogs);
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- test/public-archive-lists.test.ts`

Expected: FAIL because archive access/service modules do not exist.

- [ ] **Step 3: Implement access rules**

In `access.ts`, implement:

- `requireArchiveListManager(db, listId, actor)` allowing owner, member, or current admin;
- `requireArchiveListOwnerOrAdmin(...)` for member/source management;
- `effectiveSourceAccounts(...)`, including owner automatically;
- source-session visibility checks using the existing collaboration membership and personal-cloud ownership rules.

Do not let membership alone grant access to another account's source sessions.

- [ ] **Step 4: Implement source catalog and snapshot transaction**

In `service.ts`, use `listAccountSessions`/the existing catalog model for available sessions. For a personal source, read the validated personal snapshot JSON and copy only the requested closed session plus non-deleted logs. For collaboration, read `sessions` and `logs` directly and require closed/non-deleted status.

Implement snapshot insertion/refesh as one transaction:

```ts
db.transaction(() => {
  // insert or replace archive session metadata
  // delete old public_archive_list_logs rows only for explicit refresh
  // insert logs sorted by time then sync_id and assign ordinal starting at 1
})();
```

Reject duplicate creation with `409 ARCHIVE_SESSION_ALREADY_ADDED`; require the explicit refresh action to overwrite a snapshot.

- [ ] **Step 5: Implement reorder/remove/publish lifecycle**

Use a single transaction to validate every `archiveSessionId` in a reorder payload and write contiguous zero-based `display_order` values. Soft-delete archive lists; delete archive session/log rows on removal. Publish only non-deleted lists.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- test/public-archive-lists.test.ts`

Expected: PASS for ownership, membership, source authorization, immutable snapshot, explicit refresh, reorder, and publication lifecycle.

- [ ] **Step 7: Commit**

```bash
git add src/public-archives src/session-catalog/account-session-catalog.ts test/public-archive-lists.test.ts
git commit -m "feat: add public archive snapshots"
```

### Task 3: Management, Anonymous, and Alias APIs

**Files:**
- Create: `src/api/public-archive-lists-v1.ts`
- Create: `src/api/admin-public-archive-lists-v1.ts`
- Create: `src/api/public-archives-v1.ts`
- Modify: `src/app.ts`
- Test: `test/public-archive-lists.test.ts`

- [ ] **Step 1: Write failing API contract tests**

Test:

```ts
assert.equal((await request('POST', '/api/v1/public-archive-lists', ownerToken, {
  title: '浙江省业余无线电协会台网点名活动',
})).status, 201);

assert.equal((await request('GET', `/api/v1/public/archive-lists/${listId}`)).status, 404);
assert.equal((await request('POST', `/api/v1/public-archive-lists/${listId}/publish`, ownerToken)).status, 200);
assert.equal((await request('GET', `/api/v1/public/archive-lists/${listId}`)).status, 200);
assert.equal((await request('PUT', `/api/v1/admin/public-archive-lists/${listId}/alias`, adminToken, {
  alias: 'BR5AI',
})).status, 200);
assert.equal((await request('GET', '/api/v1/public/archive-aliases/BR5AI')).status, 200);
```

Also assert unknown JSON keys return `422 VALIDATION_FAILED`, member source changes return 403, normal users cannot assign aliases, unpublished/removed detail pages return 404, and alias collisions return `409 ARCHIVE_ALIAS_TAKEN`.

- [ ] **Step 2: Run the API tests and verify they fail**

Run: `npm test -- test/public-archive-lists.test.ts`

Expected: FAIL with 404 or missing router errors.

- [ ] **Step 3: Implement authenticated routers**

Use `createAccessTokenMiddleware` and existing strict JSON/query helpers. Expose all management endpoints in the approved spec. Return paginated available sessions using `page`, `pageSize`, and optional source filter; reject unknown query parameters.

Use the existing `AppError` envelope and these codes: `ARCHIVE_LIST_FORBIDDEN`, `ARCHIVE_SOURCE_NOT_AUTHORIZED`, `ARCHIVE_SESSION_ALREADY_ADDED`, `ARCHIVE_ALIAS_TAKEN`, `ARCHIVE_ALIAS_INVALID`, and `ARCHIVE_SESSION_NOT_CLOSED`.

- [ ] **Step 4: Implement anonymous read router**

Return only published list/session snapshot DTOs, with `Cache-Control: no-store`. Make every missing/unpublished/deleted list, alias, or archive session return the same 404 `NOT_FOUND` envelope.

- [ ] **Step 5: Mount routers and root alias SPA routes**

In `src/app.ts`, mount management routes under `/api/v1/public-archive-lists`, admin aliases under `/api/v1/admin`, and anonymous reads under `/api/v1/public`.

Before the generic WebUI static fallback, add routes for `/:alias` and `/:alias/session/:archiveSessionId`. Validate the first segment against reserved names before serving `live/dist/index.html`; look up only published aliases. Return 404 when the alias is unavailable. Preserve existing `/live/:publicShareId` handling unchanged.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- test/public-archive-lists.test.ts`

Expected: PASS for API contracts, anonymous 404 behavior, alias authorization, and root/nested alias routing.

- [ ] **Step 7: Commit**

```bash
git add src/api src/app.ts test/public-archive-lists.test.ts
git commit -m "feat: expose public archive lists"
```

### Task 4: Public Archive Reader and LiveShare Token Retention

**Files:**
- Create: `live/src/archive.ts`
- Create: `live/test/archive.test.ts`
- Create: `live/test/link.test.ts`
- Modify: `live/src/link.ts`
- Modify: `live/src/types.ts`
- Modify: `live/src/App.tsx`
- Modify: `live/src/App.css`
- Modify: `live/src/i18n.ts`

- [ ] **Step 1: Write failing LiveShare link and archive tests**

Add a link parser test:

```ts
window.history.replaceState(null, '', '/live/share-1#token=secret-value-at-least-32-characters');
const link = consumePublicLink();
assert.equal(link.publicShareId, 'share-1');
assert.equal(link.secret, 'secret-value-at-least-32-characters');
assert.equal(window.location.hash, '#token=secret-value-at-least-32-characters');
```

Add archive tests that mock `fetch` and assert archive mode calls only
`/api/v1/public/archive-lists/...` or `/api/v1/public/archive-aliases/...`, never
calls exchange, public snapshot, ticket, or WebSocket APIs.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd live && npm test`

Expected: FAIL because the fragment is still removed and archive mode does not exist.

- [ ] **Step 3: Retain the LiveShare fragment token**

Delete only the `history.replaceState(...)` block in `live/src/link.ts`. Keep validation and in-memory return values unchanged; do not persist the token in storage, logs, or React state beyond existing link initialization.

- [ ] **Step 4: Add archive route parsing and fetch module**

Create `archive.ts` with:

```ts
export type ArchiveRoute =
  | { kind: 'list'; listId?: string; alias?: string }
  | { kind: 'session'; listId?: string; alias?: string; archiveSessionId: string };
```

Parse `/live/list/:listId[/session/:archiveSessionId]` and root aliases
`/:alias[/session/:archiveSessionId]`. Fetch the matching anonymous route once;
no timers, access-token exchange, visitor-session ID, or WebSocket code may be
used in this module.

- [ ] **Step 5: Add archive UI mode**

In `App.tsx`, select archive mode before `usePublicLiveshare` when the pathname
matches an archive route. Reuse `LogCard`, search, locale/theme controls, and
pagination. Add directory cards for archived sessions and breadcrumb navigation
for details. Ensure alias links retain the alias pathname, e.g.
`/BR5AI/session/:archiveSessionId`, instead of changing to internal list URLs.

- [ ] **Step 6: Add translations and styling**

Add Chinese and English keys for archive title, session directory, record count,
back to list, archived session, unavailable archive, and static archive status.
Keep existing LiveShare loading/realtime labels restricted to LiveShare mode.

- [ ] **Step 7: Run public-client verification**

Run:

```bash
cd live && npm test && npm run lint && npm run build
```

Expected: all pass; archive mode is static and the LiveShare URL hash remains visible.

- [ ] **Step 8: Commit**

```bash
git add live
git commit -m "feat: add public archive reader"
```

### Task 5: Authenticated WebUI List Management and Admin Aliases

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Create: `web/src/pages/app/PublicArchiveListsPage.tsx`
- Create: `web/src/pages/admin/PublicArchiveListsPage.tsx`
- Modify: `web/src/App.tsx`
- Modify: existing app/admin shell navigation component(s)
- Create: `web/src/pages/app/PublicArchiveListsPage.test.tsx`
- Create: `web/src/pages/admin/PublicArchiveListsPage.test.tsx`

- [ ] **Step 1: Write failing WebUI tests**

Member test: render list workspace, create a list, add an eligible closed
session, publish it, and verify the copied internal URL is `/live/list/:listId`.

Admin test: render all lists, set `BR5AI`, verify duplicate/reserved server
errors are displayed, and verify the copied public URL is `/BR5AI`.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd web && npm test -- PublicArchiveListsPage`

Expected: FAIL because pages and API methods do not exist.

- [ ] **Step 3: Add client types and API methods**

Add `PublicArchiveList`, `PublicArchiveSession`, `AvailableArchiveSourceSession`,
and member/source DTOs. Add methods matching Task 3 endpoints. Use the existing
`api` wrapper so access-token refresh, errors, and React Query conventions stay
consistent.

- [ ] **Step 4: Implement member workspace**

Create a concise management page with list table, create/edit title modal,
publish toggle, member/source controls gated by owner/admin metadata, paginated
eligible-session picker, archive-session order controls, manual refresh/removal,
and copy-link action. Invalidate list/detail/session query keys after every
mutation.

- [ ] **Step 5: Implement admin controls and routes**

Add `/app/public-archives` and `/admin/public-archives` routes in `web/src/App.tsx`
and matching shell navigation links. The admin page lists all archive lists and
provides alias create/replace/delete controls. Only show root alias copy action
when an alias exists.

- [ ] **Step 6: Run WebUI verification**

Run:

```bash
cd web && npm test && npm run lint && npm run build
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add web
git commit -m "feat: manage public archive lists"
```

### Task 6: Documentation, Proxy Guidance, and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `web/README.md`
- Modify: `live/README.md`
- Create: `docs/public-archive-lists-api-v1.md`
- Modify: `docs/public-liveshare-statistics-api-v1.md`
- Modify: `deploy/nginx-openlogtool.conf.example`
- Test: `test/public-archive-lists.test.ts`, `live/test/link.test.ts`

- [ ] **Step 1: Write the public archive API document**

Document every management and anonymous endpoint from Task 3, exact request and
response shapes, pagination, all archive error codes, owner/member/admin matrix,
immutable snapshot behavior, tokenless 404 behavior, and root alias rules.

- [ ] **Step 2: Update repository documentation**

Update:

- `README.md` feature/API tables with archive lists, `/live/list/:listId`,
  root aliases, and the fact that LiveShare retains `#token`;
- `live/README.md` to distinguish capability-based realtime LiveShare from
  tokenless static archive pages and remove the claim that fragments are erased;
- `web/README.md` for member list management and admin aliases;
- LiveShare statistics documentation to say archive pages do not use
  public-share visitor tracking or WebSocket metrics.

- [ ] **Step 3: Update reverse-proxy example**

Keep `location /` forwarding to Express and add comments stating it must not
rewrite or reject public aliases such as `/BR5AI` or nested
`/BR5AI/session/<id>`. Preserve the dedicated `/ws/` Upgrade block and explain
that archives do not need WebSocket Upgrade.

- [ ] **Step 4: Run the full repository verification**

Run: `npm run verify`

Expected: typecheck, server tests, dist tests, WebUI verification, and live
client verification all pass.

- [ ] **Step 5: Inspect final changes**

Run:

```bash
git status -s
git diff --check
git log --oneline -10
```

Expected: only intended archive, LiveShare, and documentation files are staged;
leave unrelated `server.log` untracked and untouched.

- [ ] **Step 6: Commit**

```bash
git add README.md web/README.md live/README.md docs deploy/nginx-openlogtool.conf.example
git commit -m "docs: document public archive lists"
```

## Plan Self-Review

- Spec coverage: Tasks 1-3 implement data, authorization, snapshots, APIs,
  aliases, and 404 behavior; Task 4 implements static public presentation and
  retained LiveShare tokens; Task 5 implements owner/member/admin management;
  Task 6 updates all required documentation and deployment guidance.
- Placeholder scan: no deferred implementation sections; every task lists paths,
  commands, expected verification, and a commit boundary.
- Type consistency: `PublicArchiveList`, `PublicArchiveSession`, alias routes,
  `archiveSessionId`, source accounts, and the API route families use the same
  names throughout the plan.
