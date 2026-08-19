# Public Archive Lists Design

## Purpose

Provide named, public, read-only archives for completed amateur-radio net
activities. A list can collect multiple closed sessions, such as `浙江省业余
无线电协会台网点名活动`, and present a directory of sessions followed by each
session's full logging record.

This is deliberately separate from Live Share:

- Live Share exposes one active collaboration session through an expiring
  capability URL and updates in real time.
- A public archive list is a persistent, non-realtime, published collection of
  immutable completed-session snapshots.

## Scope

This feature includes:

- collaborative management of named archive lists;
- server-side snapshots of closed personal-cloud and collaboration sessions;
- anonymous public archive pages with session-directory and session-detail
  views;
- administrator-configured root-path aliases such as `/BR5AI`;
- retaining Live Share fragment tokens when a visitor opens a Live Share URL;
- documentation for APIs, the public page, and reverse-proxy deployment.

It does not add realtime updates, public editing, public comments, visitor
analytics, list-level token access, or automatic list expiry.

## Terms

- **List**: A named collection of immutable archived session snapshots.
- **List owner**: The account that creates the list. It remains the ordinary
  list administrator.
- **List member**: An account invited to manage the list.
- **Source account**: An account whose closed sessions may be copied into a
  list. A list normally authorizes only its owner as a source.
- **Snapshot**: A copy of the selected session metadata and all non-deleted
  logs at the moment that session is added or refreshed in a list.
- **Published list**: A list visible to anonymous visitors.
- **Alias**: An administrator-managed, globally unique root path that resolves
  to one published list, for example `/BR5AI`.

## Data Model

### Lists and membership

Add these tables:

```text
public_archive_lists
  id                 TEXT PRIMARY KEY
  title              TEXT NOT NULL
  owner_user_id      TEXT NOT NULL REFERENCES users(id)
  is_published       INTEGER NOT NULL DEFAULT 0
  created_at         TEXT NOT NULL
  updated_at         TEXT NOT NULL
  unpublished_at     TEXT
  deleted_at         TEXT

public_archive_list_members
  list_id            TEXT NOT NULL REFERENCES public_archive_lists(id)
  user_id            TEXT NOT NULL REFERENCES users(id)
  added_by           TEXT NOT NULL REFERENCES users(id)
  created_at         TEXT NOT NULL
  PRIMARY KEY (list_id, user_id)

public_archive_list_sources
  list_id            TEXT NOT NULL REFERENCES public_archive_lists(id)
  user_id            TEXT NOT NULL REFERENCES users(id)
  authorized_by      TEXT NOT NULL REFERENCES users(id)
  created_at         TEXT NOT NULL
  PRIMARY KEY (list_id, user_id)
```

Every list owner is an effective manager and source account without requiring
redundant owner rows. Member and source rows add privileges beyond that default.

### Archived session snapshots

```text
public_archive_list_sessions
  id                 TEXT PRIMARY KEY
  list_id            TEXT NOT NULL REFERENCES public_archive_lists(id)
  source_user_id     TEXT NOT NULL REFERENCES users(id)
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('personal', 'collaboration'))
  source_session_id  TEXT NOT NULL
  title              TEXT NOT NULL
  status             TEXT NOT NULL CHECK (status = 'closed')
  closed_at          TEXT NOT NULL
  source_created_at  TEXT NOT NULL
  snapshot_at        TEXT NOT NULL
  display_order      INTEGER NOT NULL
  created_by         TEXT NOT NULL REFERENCES users(id)
  created_at         TEXT NOT NULL
  updated_at         TEXT NOT NULL
  UNIQUE (list_id, source_user_id, source_kind, source_session_id)

public_archive_list_logs
  archive_session_id TEXT NOT NULL REFERENCES public_archive_list_sessions(id)
  source_sync_id     TEXT NOT NULL
  ordinal            INTEGER NOT NULL
  time               TEXT NOT NULL
  controller         TEXT NOT NULL
  callsign           TEXT NOT NULL
  rst_sent           TEXT
  rst_rcvd           TEXT
  qth                TEXT
  device             TEXT
  power              TEXT
  antenna            TEXT
  height             TEXT
  remarks            TEXT
  PRIMARY KEY (archive_session_id, source_sync_id)
```

The snapshot transaction inserts the archived session and all of its logs from
the authoritative source in one database transaction. Records marked deleted at
the source are excluded. Subsequent edits, deletion, or access changes to the
source session never mutate an archive snapshot.

Adding the same source session to the same list refreshes its snapshot in place
only when an authorized manager explicitly requests it. The UI labels this as a
manual refresh; there is no background sync.

### Public aliases

```text
public_archive_aliases
  alias              TEXT PRIMARY KEY
  list_id            TEXT NOT NULL UNIQUE REFERENCES public_archive_lists(id)
  created_by         TEXT NOT NULL REFERENCES users(id)
  created_at         TEXT NOT NULL
  updated_at         TEXT NOT NULL
```

An alias is case-insensitive and normalized to lowercase for uniqueness. The
public route preserves the administrator's chosen display casing where the
deployment supports it, but routing remains case-insensitive.

Aliases match `[A-Za-z0-9][A-Za-z0-9-]{0,62}` and must not collide with system
paths or reserved names, including `api`, `admin`, `app`, `live`, `web`, `ws`,
`assets`, `favicon.ico`, `health`, and `robots.txt`.

## Authorization

| Action | List owner | List member | Server administrator | Anonymous visitor |
|---|---:|---:|---:|---:|
| Read management metadata | yes | yes | yes | no |
| Edit title / publish / unpublish | yes | yes | yes | no |
| Add, refresh, reorder, remove snapshots | yes | yes | yes | no |
| Add or remove members | yes | no | yes | no |
| Authorize or revoke source accounts | yes | no | yes | no |
| Assign or remove root-path alias | no | no | yes | no |
| Read a published public page | n/a | n/a | n/a | yes |

List members may manage list contents but cannot silently broaden the set of
accounts whose closed sessions are visible. Only the list owner or an
administrator can authorize another source account.

A manager can add a source session only when all of these are true:

1. the session belongs to an effective source account;
2. the session is closed and not deleted;
3. the manager can access it through the same personal-cloud or collaboration
   authorization rules used by the authenticated WebUI;
4. the source session is not already present in the list.

The source-session picker defaults to the list owner's sessions. It reuses the
existing WebUI session-pagination data source and exposes personal-cloud and
collaboration sessions together. Managers see another account's sessions only
after that account is an authorized source and the manager has ordinary access
to those sessions.

## Management API

All management routes require ordinary bearer authentication. Existing admin
middleware additionally accepts a current administrator for every route.

```text
GET    /api/v1/public-archive-lists
POST   /api/v1/public-archive-lists
GET    /api/v1/public-archive-lists/:listId
PATCH  /api/v1/public-archive-lists/:listId
DELETE /api/v1/public-archive-lists/:listId

POST   /api/v1/public-archive-lists/:listId/publish
POST   /api/v1/public-archive-lists/:listId/unpublish

GET    /api/v1/public-archive-lists/:listId/sources
PUT    /api/v1/public-archive-lists/:listId/sources/:userId
DELETE /api/v1/public-archive-lists/:listId/sources/:userId

GET    /api/v1/public-archive-lists/:listId/members
PUT    /api/v1/public-archive-lists/:listId/members/:userId
DELETE /api/v1/public-archive-lists/:listId/members/:userId

GET    /api/v1/public-archive-lists/:listId/available-sessions
POST   /api/v1/public-archive-lists/:listId/sessions
PUT    /api/v1/public-archive-lists/:listId/sessions/:archiveSessionId/refresh
PATCH  /api/v1/public-archive-lists/:listId/sessions/order
DELETE /api/v1/public-archive-lists/:listId/sessions/:archiveSessionId

PUT    /api/v1/admin/public-archive-lists/:listId/alias
DELETE /api/v1/admin/public-archive-lists/:listId/alias
```

List and available-session collection endpoints use the existing bounded
pagination and strict query validation conventions. Mutating endpoints reject
unknown JSON keys and return the standard API v1 error envelope.

`POST .../sessions` accepts a source account, source kind, and source session
ID. It creates the snapshot synchronously, returning the new archived-session
metadata only after all logs are copied. A refresh uses the same transaction and
is allowed only for a source session that remains closed and accessible.

Publishing does not allocate credentials. It only sets `is_published`; an
unpublished, deleted, or missing list is never available to anonymous routes.

## Anonymous Public API and Routes

Public archive reads intentionally require no token, cookie, fragment secret,
access JWT, WebSocket ticket, or WebSocket connection:

```text
GET /api/v1/public/archive-lists/:listId
GET /api/v1/public/archive-lists/:listId/sessions/:archiveSessionId
GET /api/v1/public/archive-aliases/:alias
GET /api/v1/public/archive-aliases/:alias/sessions/:archiveSessionId
```

The public API sends `Cache-Control: no-store` and returns only frozen archive
data. Unknown, unpublished, deleted, or unaliased resources return the same
404 response, preventing a public endpoint from disclosing unpublished list
existence.

The public React application remains mounted at `/live` for existing Live
Share URLs and gains an archive mode. Canonical internal archive routes are:

```text
/live/list/:listId
/live/list/:listId/session/:archiveSessionId
```

Administrator aliases are root paths:

```text
/:alias
/:alias/session/:archiveSessionId
```

The Express root-path alias handler serves the same Live bundle index without a
redirect. The browser therefore keeps `/BR5AI` in its address bar as the public
primary link. The client derives alias mode from the current pathname and calls
the alias public API; it must not replace the alias with an internal list ID
route.

Aliases are available only while the target list is published. Unpublishing,
soft-deleting a list, removing an archived session, or deleting an alias makes
the affected public route return 404 immediately. Removing one archived
session leaves the list route available while its former detail URL returns
404.

## Public Page

Archive mode reuses the existing `live/` visual language, theme preference,
locale preference, log-card fields, search control, pagination, footer, and
responsive behavior. It deliberately removes the Live Share-specific state
machine, capability exchange, public access JWT renewal, visitor tracking,
WebSocket connection, and live status pill.

The list page shows:

- the archive-list title;
- a session directory ordered by `display_order`, then closed time;
- each session's title, close time, and log count;
- a link to that session's static detail page.

The session detail page shows:

- breadcrumb navigation back to the archive list;
- the archived session title, close time, and record count;
- search, newest-first log cards, stable ordinal numbers, and pagination using
  the existing Live Share presentation.

There is no polling or automatic refresh. A visitor only sees a changed
snapshot after a list manager explicitly refreshes that session and the visitor
loads the page again.

## Live Share Compatibility

Existing Live Share remains a separate feature with its existing expiring
capability URL and public WebSocket protocol:

```text
/live/{publicShareId}#token={secret}
```

The Live Share client must retain the fragment token in the visible browser URL
after load. It may keep the parsed secret only in page memory for protocol use,
but it must not call `history.replaceState`, `location.replace`, or any other
mechanism that removes `#token=...` from the address bar or browser history.

No archive page can use a Live Share secret, and no Live Share page can resolve
an archive alias.

## WebUI

Add a member-facing public-archive-list workspace under `/app`:

- list the current user's owned and joined archive lists;
- create lists and edit titles;
- manage members (owner/admin) and source accounts (owner/admin);
- choose eligible closed sessions from the existing paginated source-session
  picker;
- add, manually refresh, reorder, or remove snapshots;
- publish or unpublish a list;
- copy the internal public route when no administrator alias exists.

Add administration controls under `/admin`:

- inspect and manage all lists;
- assign, replace, or delete an alias;
- validate and explain reserved or duplicate aliases;
- copy the root-path public address.

All management mutations invalidate the relevant React Query cache keys. The
public archive app fetches only anonymous archive routes and never consumes the
authenticated WebUI token or cookies.

## Migration and Operations

Add one forward-only SQLite migration that creates the five archive tables,
foreign-key and query indexes, alias uniqueness, and initial reserved-name
validation at the application layer. It must not alter existing Live Share
tables, tokens, statistics, or event retention.

The Express static/routing configuration must resolve public root aliases
before a generic site fallback, while preserving `/api`, `/admin`, `/app`,
`/live`, `/web`, `/ws`, assets, health checks, and static files. The public
alias handler must reject all reserved paths before database lookup.

Deployment documentation must require the reverse proxy to forward unknown
public root paths and nested `/:alias/session/:archiveSessionId` paths to the
server. It must continue forwarding `/live`, `/api`, and `/ws`; archive pages
do not require WebSocket Upgrade.

## Documentation Updates

Implementation updates these server-repository documents with the shipped
behavior:

- `README.md`: feature overview, public archive routes, alias reverse-proxy
  behavior, and Live Share token retention.
- `live/README.md`: distinguish Live Share capability URLs from static public
  archive pages; document that Live Share no longer removes the token fragment.
- `web/README.md`: document the authenticated archive-list management and
  admin alias controls.
- a new `docs/public-archive-lists-api-v1.md`: authenticated management API,
  anonymous API schemas, authorization, snapshots, alias rules, status codes,
  and 404 behavior.
- existing Live Share statistics documentation only where terminology must
  explicitly distinguish Live Share from tokenless archive lists.

## Errors and Edge Cases

- `403 ARCHIVE_LIST_FORBIDDEN`: caller is neither a list manager nor an admin.
- `403 ARCHIVE_SOURCE_NOT_AUTHORIZED`: selected source account is not enabled
  for the list.
- `409 ARCHIVE_SESSION_ALREADY_ADDED`: source session already has a snapshot in
  the list.
- `409 ARCHIVE_ALIAS_TAKEN` or `422 ARCHIVE_ALIAS_INVALID`: alias is duplicate,
  reserved, or malformed.
- `422 ARCHIVE_SESSION_NOT_CLOSED`: an active or deleted source session cannot
  be archived or refreshed.
- `404` for every unavailable anonymous list/session/alias case.

Deleting an owner account follows existing account-deletion policy. Before that
policy permits deletion, any owned archive lists must be transferred, deleted,
or otherwise handled explicitly; it must never silently leave anonymous content
without an accountable manager.

## Testing

Server tests cover:

- migrations and indexes;
- owner, member, source-account, and administrator authorization boundaries;
- personal and collaboration source-session eligibility;
- immutable snapshot creation, manual refresh, ordering, and removal;
- publishing/unpublishing and indistinguishable anonymous 404 behavior;
- alias validation, collisions, root-path routing, and nested detail routes;
- retention of Live Share fragment token behavior;
- no WebSocket or access-token APIs invoked by archive mode.

WebUI tests cover list creation, membership/source authorization controls,
session selection, snapshot management, publishing, and admin alias validation.
The `live/` test suite covers archive directory/detail loading, static record
presentation, alias pathname preservation, and unchanged Live Share realtime
behavior apart from retaining the fragment token.
