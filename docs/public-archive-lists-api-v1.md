# Public Archive Lists API v1

Public archive lists are authenticated management objects made from closed
personal or collaboration sessions. Publishing exposes copied snapshots through
tokenless read endpoints. Archive reads are separate from LiveShare
capabilities and do not use access tokens, cookies, visitor IDs, polling, or
WebSockets.

All responses use the standard API v1 envelope. Successful JSON responses are
`{"data": ...}`. Management and anonymous read responses use
`Cache-Control: no-store`. Request bodies must be JSON objects. Unknown body
keys and unknown query keys are rejected with `422 VALIDATION_FAILED`.

## Authentication and permissions

Management endpoints require `Authorization: Bearer <access-token>`. The
current database role is used; `admin` is the administrator role.

| Capability | Owner | List member | Admin |
|---|---:|---:|---:|
| Read/manage visible lists | Yes | Yes | All lists |
| Create a list | Yes | Yes | Yes |
| Edit title | Yes | Yes | Yes |
| Publish/unpublish | Yes | Yes | Yes |
| Add/remove/refresh/reorder/remove content snapshots | Yes | Yes | Yes |
| View eligible sessions | Yes | Yes | Yes |
| Manage list members | Yes | No | Yes |
| Manage source accounts | Yes | No | Yes |
| Set/delete a root alias | No | No | Yes |

Members can manage content, but membership does not grant access to another
account's source sessions. The owner is automatically an eligible source
account. Additional source accounts must be explicitly authorized by the
owner or an admin; personal sessions require the actor to own the source
account, and collaboration sessions require current collaboration membership.

## DTOs and envelopes

Authenticated list DTOs contain `id`, `title`, `ownerUserId`, `isPublished`,
optional `displayAlias`, `capabilities.canManageContents`,
`capabilities.canManageAccounts`, and optional `sessions`. Authenticated
session DTOs contain `id`, `listId`, `sourceUserId`, `sourceKind`,
`sourceSessionId`, `title`, `closedAt`, zero-based `displayOrder`, `logCount`,
and `snapshotAt`.

The anonymous list DTO contains only `id` and `title`. Its session DTO contains
only `id`, `title`, `closedAt`, `displayOrder`, and `logCount`. Its log DTO
contains `ordinal`, `time`, `controller`, `callsign`, `rstSent`, `rstRcvd`,
`qth`, `device`, `power`, `antenna`, `height`, and `remarks`; nullable fields
are returned as `null`.

## Authenticated management

Base path: `/api/v1/public-archive-lists`.

| Method and path | Request | Response |
|---|---|---|
| `GET /` | Query `page` 1..10000 and `pageSize` 1..100; defaults 1 and 25 | `{ data: { items, page, pageSize, total, totalPages } }` |
| `POST /` | `{ "title": string }`, max 256 characters | `201`, `{ data: PublicArchiveList }` |
| `GET /:listId` | No query/body | `{ data: PublicArchiveList }` |
| `PATCH /:listId` | `{ "title": string }`, max 256 characters | `{ data: PublicArchiveList }` |
| `DELETE /:listId` | `{}` | `204` |
| `POST /:listId/publish` | `{}` | `{ data: PublicArchiveList }` |
| `POST /:listId/unpublish` | `{}` | `{ data: PublicArchiveList }` |
| `GET /:listId/members` | No query | `{ data: [{ "userId": string }] }` |
| `PUT /:listId/members/:userId` | `{}` | `204` |
| `DELETE /:listId/members/:userId` | `{}` | `204` |
| `GET /:listId/sources` | No query | `{ data: [{ "userId": string }] }` |
| `PUT /:listId/sources/:userId` | `{}` | `204` |
| `DELETE /:listId/sources/:userId` | `{}` | `204` |
| `GET /:listId/available-sessions` | Query `page`, `pageSize`, optional `source=personal|collaboration` | `{ data: { items, page, pageSize, total, totalPages } }` |
| `POST /:listId/sessions` | `{ "sourceUserId": string, "sourceKind": "personal"|"collaboration", "sourceSessionId": string }` | `201`, `{ data: PublicArchiveSession }` |
| `PUT /:listId/sessions/:archiveSessionId/refresh` | `{}` | `{ data: PublicArchiveSession }` |
| `PATCH /:listId/sessions/order` | `{ "archiveSessionIds": string[] }`, exactly all current IDs once | `204` |
| `DELETE /:listId/sessions/:archiveSessionId` | `{}` | `204` |

`page` and `pageSize` must be positive decimal strings within the stated
bounds. The list endpoint accepts only `page` and `pageSize`. The
available-session endpoint accepts only `page`, `pageSize`, and `source`. There
is no HTTP `q` parameter, even though the lower-level catalog service supports
search internally.

Available-session items contain `source`, `sessionId`, `title`, `status`,
`role`, `ownerUserId`, `ownerUsername`, `logCount`, `createdAt`, `updatedAt`,
`closedAt`, `deletedAt`, and `snapshotRevision`. Only closed, non-deleted
sessions are listed. They are sorted by updated time descending, then source
and session ID.

Snapshots copy the selected closed session and non-deleted logs into archive
tables. Logs are ordered by source `time`, then `sync_id`, and receive
one-based immutable archive ordinals. Later source edits or deletion do not
change an archive. Creating the same source twice returns
`409 ARCHIVE_SESSION_ALREADY_ADDED`; only explicit refresh replaces a snapshot.
Removing a snapshot deletes its copied logs. Reordering requires the complete
current ID set and writes contiguous zero-based order.

## Administrator aliases

These routes are mounted under `/api/v1/admin` and require an admin token:

| Method and path | Request | Response |
|---|---|---|
| `PUT /public-archive-lists/:listId/alias` | `{ "alias": string }` | `{ data: { id, title, displayAlias } }` |
| `DELETE /public-archive-lists/:listId/alias` | `{}` | `204` |

An alias is trimmed, must match `[A-Za-z0-9][A-Za-z0-9-]{0,62}`, and may not
use reserved root paths: `api`, `admin`, `app`, `assets`, `bootstrap`,
`favicon.ico`, `health`, `live`, `login`, `register`, `robots.txt`, `web`, or
`ws`. Matching is case-insensitive and stores the normalized lowercase alias;
`displayAlias` preserves submitted casing. Collisions return
`409 ARCHIVE_ALIAS_TAKEN`; invalid values return `422 ARCHIVE_ALIAS_INVALID`.

## Anonymous reads

No authorization header is required. The router rejects every query parameter,
sets `Cache-Control: no-store`, and exposes only published, non-deleted lists:

| Method and path | Response |
|---|---|
| `GET /api/v1/public/archive-lists/:listId` | `{ data: { id, title, sessions: PublicArchiveSessionDto[] } }` |
| `GET /api/v1/public/archive-lists/:listId/sessions/:archiveSessionId` | `{ data: { session: PublicArchiveSessionDto, logs: PublicArchiveLogDto[] } }` |
| `GET /api/v1/public/archive-aliases/:alias` | Same list response; alias matching is case-insensitive |
| `GET /api/v1/public/archive-aliases/:alias/sessions/:archiveSessionId` | Same detail response |

Unknown, unpublished, deleted, removed, or mismatched resources all return
the same `404 NOT_FOUND` envelope. These endpoints do not exchange a token,
set or read cookies, create visitor analytics, open a WebSocket, or poll.

## Browser routes and errors

The live bundle reads the anonymous API through `/live/list/:listId` and
`/live/list/:listId/session/:archiveSessionId`, or through `/:alias` and
`/:alias/session/:archiveSessionId`. Express serves the Live SPA at a root
alias only when it resolves to a published list, and for a nested path only
when the archived session exists. Reserved paths fall through to normal
application routes. A missing or unpublished root alias is the normal server
`404 NOT_FOUND`; an API 404 displays the Live bundle's unavailable state.

Relevant errors include `401 AUTH_REQUIRED`, `403 ARCHIVE_LIST_FORBIDDEN`,
`403 ARCHIVE_SOURCE_NOT_AUTHORIZED`, `404 NOT_FOUND`, `404 USER_NOT_FOUND`,
`409 ARCHIVE_SESSION_ALREADY_ADDED`, `409 ARCHIVE_ALIAS_TAKEN`, and `422
ARCHIVE_ALIAS_INVALID`, `422 ARCHIVE_SESSION_NOT_CLOSED`, or `422
VALIDATION_FAILED`.
