# Personal dictionary snapshot v1

This API stores one private, account-scoped snapshot of dictionary changes.
It is independent from the personal records snapshot and from collaboration
Sessions. The server advertises `personalDictionarySnapshots` in
`GET /api/v1/server-info`; all endpoints require a normal Bearer token and
return `Cache-Control: no-store`.

The snapshot contains user additions and deletion overrides only. Active
built-in defaults are supplied by each client release and must not be uploaded.

~~~json
{
  "version": 1,
  "exportedAt": "2026-07-19T01:02:03.456Z",
  "items": [
    {
      "dictType": "callsign",
      "raw": "BG5AAA",
      "origin": "user",
      "state": "active",
      "pinyin": null,
      "abbreviation": null
    },
    {
      "dictType": "antenna",
      "raw": "Yagi",
      "origin": "builtin",
      "state": "deleted",
      "pinyin": null,
      "abbreviation": null
    }
  ]
}
~~~

`dictType` is `device`, `antenna`, `callsign`, or `qth`; `origin` is `user`
or `builtin`; `state` is `active` or `deleted`. Active entries must have user
origin. Deleted entries must set both searchable fields to null. `(dictType,
raw)` is unique. Objects use strict field allowlists. `raw` is 1–500 UTF-16
code units, pinyin is at most 1,000, and abbreviation at most 500. Timestamps
are complete RFC 3339 values. A snapshot is limited to 20,000 items and 4 MiB
of normalized JSON, additionally bounded by the deployment `JSON_BODY_LIMIT`.

The account endpoints are:

- `GET /api/v1/account/personal-dictionary-snapshot` for metadata and ETag;
- `GET /api/v1/account/personal-dictionary-snapshot/download` for metadata and content;
- `PUT /api/v1/account/personal-dictionary-snapshot` for atomic replacement.

Before the first upload metadata returns `exists: false` and revision zero.
PUT requires the current non-negative revision in `expectedRevision`, a quoted
revision in `If-Match`, or both with matching values, plus the literal
confirmation `REPLACE_PERSONAL_DICTIONARY_SNAPSHOT`. A stale revision returns
`409 PERSONAL_DICTIONARY_SNAPSHOT_REVISION_CONFLICT`. Identical content is an
idempotent success without a revision increment. SHA-256 excludes `exportedAt`
and canonicalizes item order by type and raw.

The server stores dictionary snapshots in a table and revision separate from
record snapshots. This compatibility boundary is intentional: a records-only
client can continue replacing `personal-snapshot` v1 without seeing or
deleting dictionary data.

Administrators may list metadata at
`GET /api/v1/admin/personal-dictionary-snapshots` and inspect a validated
snapshot at `GET /api/v1/admin/personal-dictionary-snapshots/:userId`.
Detail access is read-only and audited as
`personal_dictionary_snapshot.detail.viewed`; audit rows never copy item
content. Account deletion removes both snapshot kinds and records their byte
counts in the governance audit.
