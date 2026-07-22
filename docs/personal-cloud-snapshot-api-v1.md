# Personal Cloud Snapshot API v1

This API stores one private, account-scoped snapshot of a user's local-only
Sessions and Logs. It is deliberately independent from collaboration Sessions:
uploading, downloading, or replacing this snapshot never creates, changes, or
deletes rows in the collaboration `sessions`, `logs`, membership, event, draft,
invite, or Live Share tables.

Dictionary changes deliberately use the separate
[`personalDictionarySnapshots`](personal-dictionary-snapshot-api-v1.md) capability,
table, revision, and endpoints. Keeping the protocols independent prevents an
older records-only client from erasing dictionary data with a v1 replacement.

The server advertises the capability as `personalCloudSnapshots` in
`GET /api/v1/server-info`. All endpoints require a normal Bearer access token
and return `Cache-Control: no-store`.

## Snapshot format

~~~json
{
  "version": 1,
  "exportedAt": "2026-07-18T20:00:00.000+08:00",
  "sessions": [
    {
      "session_id": "local-session-id",
      "title": "Friday net",
      "status": "closed",
      "created_at": "2026-07-18T19:30:00.000+08:00",
      "updated_at": "2026-07-18T20:00:00.000+08:00",
      "closed_at": "2026-07-18T20:00:00.000+08:00",
      "deleted_at": null
    }
  ],
  "logs": [
    {
      "sync_id": "stable-log-id",
      "session_id": "local-session-id",
      "time": "2026-07-18T19:31:00.000+08:00",
      "controller": "BG5AAA",
      "callsign": "BG5BBB",
      "rst_sent": "59",
      "rst_rcvd": "59",
      "qth": "Hangzhou",
      "device": null,
      "power": null,
      "antenna": null,
      "height": null,
      "remarks": null,
      "created_at": "2026-07-18T19:31:01.000+08:00",
      "updated_at": "2026-07-18T19:31:01.000+08:00",
      "deleted_at": null,
      "source_device_id": null
    }
  ]
}
~~~

The row names intentionally match the local database backup v6 format. Local
autoincrement `logs.id` and collaboration-only `sessions.share_code` are not
part of the protocol and are rejected. `source_device_id` is retained. All
objects use strict field allowlists; every Log must reference a Session in the
same snapshot, stable IDs must be unique, status is `active`, `closed`, or
`archived`. `session_id` and `sync_id` are 1–128 ASCII characters matching
`[A-Za-z0-9][A-Za-z0-9._:-]*`; Session titles are 1–500 characters. Log
`controller` and `callsign` are 1–32 characters. Nullable Log string limits are
16 for each RST, 200 for QTH/device/antenna, 64 for power/height, and 2,000 for
remarks. `source_device_id` is either null or 1–128 characters. Metadata
timestamps must be complete RFC 3339 values with `T` and an explicit `Z` or
numeric offset. For
compatibility with backup v6 and older local databases, `logs.time` may instead
be `H:mm`, `HH:mm`, `H:mm:ss`, or `HH:mm:ss` (with valid 24-hour ranges). Valid
timestamp and time-only strings are stored and returned byte-for-byte rather
than converted to server time.

The hard server limits are 5,000 Sessions, 100,000 Logs, and 8 MiB of normalized
snapshot JSON. The effective HTTP request limit is the lower of that bound and
the deployment's `JSON_BODY_LIMIT` (1 MiB by default).

When rate limiting is enabled, snapshot replacement is limited to 12 PUT
attempts per minute for each account and client IP combination. Reads are not
counted. Deployments and test harnesses may disable the existing server rate
limiting switch with `RATE_LIMIT_ENABLED=false`.

## Read metadata

`GET /api/v1/account/personal-snapshot` always succeeds for an authenticated
account. Before its first upload, it returns revision zero:

~~~json
{
  "personalSnapshot": {
    "exists": false,
    "revision": 0,
    "formatVersion": 1,
    "sessionCount": 0,
    "logCount": 0,
    "byteSize": 0,
    "checksum": null,
    "createdAt": null,
    "updatedAt": null
  }
}
~~~

The response has an `ETag` containing the quoted decimal revision, for example
`"0"` or `"3"`. `checksum` is SHA-256 over recursively key-sorted Session and
Log content (Sessions by `session_id`, Logs by globally unique `sync_id`). It
excludes `exportedAt` and is independent of array ordering, so merely
exporting unchanged local data again does not look like a change.

## Download

`GET /api/v1/account/personal-snapshot/download` returns the same metadata plus
the stored `snapshot` inside `personalSnapshot`. It returns
`404 PERSONAL_SNAPSHOT_NOT_FOUND` before the first upload. The response includes
the revision `ETag` and an attachment filename.

## Atomic dangerous replacement

`PUT /api/v1/account/personal-snapshot` replaces the entire account snapshot:

~~~json
{
  "expectedRevision": 0,
  "confirmation": "REPLACE_PERSONAL_CLOUD_SNAPSHOT",
  "snapshot": {
    "version": 1,
    "exportedAt": "2026-07-18T20:00:00.000Z",
    "sessions": [],
    "logs": []
  }
}
~~~

The caller must provide the exact current revision either as
`expectedRevision`, as `If-Match: "0"`, or as both with matching values. The
literal confirmation is mandatory even when uploading for the first time or
replacing with an empty snapshot. A stale revision returns
`409 PERSONAL_SNAPSHOT_REVISION_CONFLICT` with the current revision, checksum,
and update time; the server does not silently merge or overwrite concurrent
data. Missing concurrency protection returns
`428 PERSONAL_SNAPSHOT_REVISION_REQUIRED`.

The validation, revision comparison, and replacement run as one SQLite
`BEGIN IMMEDIATE` transaction. A content change increments the revision once.
An exact content retry (including a new `exportedAt`) returns `replaced: false`
without advancing the revision. A successful response is:

~~~json
{
  "replaced": true,
  "personalSnapshot": {
    "exists": true,
    "revision": 1,
    "formatVersion": 1,
    "sessionCount": 10,
    "logCount": 615,
    "byteSize": 330000,
    "checksum": "...64 lowercase hex characters...",
    "createdAt": "2026-07-18T12:00:00.000Z",
    "updatedAt": "2026-07-18T12:00:00.000Z"
  }
}
~~~

Replacing this private snapshot does not delete old collaboration test data.
Collaboration cleanup remains an explicit operation in the Session/admin APIs.

## Read-only administrator inspection

Personal cloud records remain account-scoped snapshots even when an
administrator inspects them. They are not imported into collaboration
`sessions` or `logs`, and administrator inspection cannot edit, close, delete,
or otherwise mutate the snapshot.

`GET /api/v1/admin/personal-snapshots?q=&page=&pageSize=` lists accounts that
currently have a snapshot. It returns the account ID and username together
with revision, counts, byte size, checksum, and timestamps, but does not return
Session or Log content. `q` searches usernames case-insensitively; `page`
defaults to 1 and `pageSize` defaults to 20 with a maximum of 100.

`GET /api/v1/admin/personal-snapshots/:userId` returns the same account and
metadata fields plus the complete, integrity-validated `snapshot`. A missing
account or snapshot returns `404 PERSONAL_SNAPSHOT_NOT_FOUND`; invalid stored
JSON or metadata that no longer matches the validated content returns
`500 PERSONAL_SNAPSHOT_CORRUPT`.

Both endpoints require a current server administrator access token and return
`Cache-Control: no-store`. Because detail responses expose personal Log
content, each detail visit is written to the append-only governance audit as
`personal_snapshot.detail.viewed`. A UI may send one stable
`X-Admin-Access-Id` for a detail visit; repeated reads by the same
administrator, target account, access ID, and 15-minute bucket produce one
audit row. The audit stores the access ID only: it never copies snapshot
content, checksums, titles, callsigns, or remarks into audit details.
