# Public Live Share Statistics API v1

This administrator-only API reports aggregate opens, current public WebSocket
connections, and bounded visitor details for Live Share links. It is separate
from `/api/v1/admin/collaboration-metrics`: the general metrics endpoint never
returns Session identity or IP addresses, while this API intentionally returns
per-share operational details to a current server administrator.

Tokenless public archive pages (`/live/list/:listId`, `/BR5AI`, and their
session detail routes) are not LiveShare links. They do not exchange a
capability, create visitor view sessions, open a public WebSocket, or
contribute to any statistics or WebSocket metrics described here.

Both endpoints require a Bearer access token whose claim and current database
role are `admin`. Responses use `Cache-Control: no-store`. When instance rate
limiting is enabled, the statistics endpoints share a limit of 30 requests per
minute for each administrator and request IP pair.

## List statistics

`GET /api/v1/admin/public-liveshare-stats?limit=50`

`limit` defaults to 50 and must be an integer from 1 through 100. Unknown query
parameters are rejected. The endpoint returns currently connected shares plus
recently active shares, sorts current connections first, and truncates the
result to `limit` items.

~~~json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-22T12:00:00.000Z",
  "scope": {
    "currentConnections": "current-process",
    "openCounts": "current-database",
    "singleProcessOnly": true,
    "anonymousPageSessions": true,
    "trackingStartedAt": "2026-07-20T10:00:00.000Z",
    "viewSessionDetailLimits": {
      "perShare": 10000,
      "total": 100000
    },
    "visitorDetailLimit": 200,
    "visitorIpSource": "trusted-request-ip"
  },
  "totals": {
    "activeShares": 2,
    "currentConnections": 3,
    "totalOpens": 120,
    "sharesWithOpens": 8,
    "saturatedShares": 0
  },
  "items": [
    {
      "publicShareId": "7aa4de16-a849-4fde-8574-dae76fd57f4c",
      "sessionId": "weekly-net",
      "sessionTitle": "Weekly net",
      "sessionStatus": "active",
      "state": "active",
      "createdAt": "2026-07-22T10:00:00.000Z",
      "expiresAt": "2026-07-23T10:00:00.000Z",
      "revokedAt": null,
      "currentConnections": 2,
      "totalOpens": 18,
      "openCountSaturated": false,
      "openCountSaturatedAt": null,
      "firstOpenedAt": "2026-07-22T10:01:00.000Z",
      "lastOpenedAt": "2026-07-22T11:58:00.000Z",
      "lastAccessedAt": "2026-07-22T11:59:00.000Z"
    }
  ]
}
~~~

`state` is `active`, `revoked`, `expired`, or `sessionDeleted`.
`currentConnections` counts active public WebSocket connections in the current
Node.js process. It approximates open pages or tabs, not unique people, and is
cleared when the process restarts. `totalOpens` and the remaining aggregate
fields come from the current database.

`openCountSaturated: true` means the deduplication-detail storage limit was
reached. In that state `totalOpens` is a lower bound rather than an exact count.

## Read one share

`GET /api/v1/admin/public-liveshare-stats/:publicShareId`

The path uses the stable public share ID and accepts no query parameters. The
endpoint returns the same item shape plus at most 200 visitor rows.

~~~json
{
  "schemaVersion": 4,
  "generatedAt": "2026-07-22T12:00:00.000Z",
  "scope": {
    "currentConnections": "current-process",
    "openCounts": "current-database",
    "singleProcessOnly": true,
    "anonymousPageSessions": true,
    "trackingStartedAt": "2026-07-20T10:00:00.000Z",
    "viewSessionDetailLimits": {
      "perShare": 10000,
      "total": 100000
    },
    "visitorDetailLimit": 200,
    "visitorIpSource": "trusted-request-ip"
  },
  "item": {
    "publicShareId": "7aa4de16-a849-4fde-8574-dae76fd57f4c",
    "sessionId": "weekly-net",
    "sessionTitle": "Weekly net",
    "sessionStatus": "active",
    "state": "active",
    "createdAt": "2026-07-22T10:00:00.000Z",
    "expiresAt": "2026-07-23T10:00:00.000Z",
    "revokedAt": null,
    "currentConnections": 2,
    "totalOpens": 18,
    "openCountSaturated": false,
    "openCountSaturatedAt": null,
    "firstOpenedAt": "2026-07-22T10:01:00.000Z",
    "lastOpenedAt": "2026-07-22T11:58:00.000Z",
    "lastAccessedAt": "2026-07-22T11:59:00.000Z"
  },
  "visitors": [
    {
      "ipAddress": "203.0.113.42",
      "firstSeenAt": "2026-07-22T10:01:00.000Z",
      "lastSeenAt": "2026-07-22T11:59:00.000Z",
      "visitCount": 3,
      "currentConnections": 1,
      "location": {
        "country": "中国",
        "province": "浙江省",
        "city": "杭州市",
        "isp": "电信",
        "displayName": "中国 浙江省 杭州市 电信",
        "source": "ip2region"
      }
    }
  ]
}
~~~

Visitor rows aggregate anonymous page-lifetime sessions by the most recently
observed IP address. `visitCount` is the number of stored page sessions grouped
into the row, while `currentConnections` is the number of live WebSocket
connections currently using that IP. IP grouping does not identify accounts or
verified people: multiple people may share an IP, and one person may use several
IPs. `firstSeenAt`, `lastSeenAt`, or `ipAddress` may be `null` for legacy or
currently connected rows that have no matching stored detail.

The server resolves public IPv4 addresses locally through the bundled
`ip2region` database and keeps a bounded in-memory result cache. No visitor IP is
sent to an external geolocation service. `location` is `null` for private,
reserved, IPv6, or failed lookups. The normalized country, province, city, ISP,
display name, and source are returned. IP database results are generally
city-level inferences, not precise positioning, and become newer only when the
bundled dependency is updated.

## Tracking and retention

The public page creates a random page-lifetime `viewSessionId`. After successful
secret verification, the server stores only a share-scoped HMAC of that ID; it
never stores or returns the raw value. Reissuing the five-minute public access
token for the same page does not increase `totalOpens`.

Aggregate open tracking begins with database migration v23. Migration v24 adds
the most recently observed trusted request IP to each stored page session and
links that session to its public WebSocket ticket. Neither migration backfills
older traffic, so `trackingStartedAt` describes the start of aggregate tracking
and older detail rows can have a null IP.

The server retains at most 10,000 page-session details per share and 100,000 in
the database. Revoking or expiring a share, or deleting its Session, permits the
detail rows and IP addresses to be cleaned up while aggregate totals remain.
The server does not store a User-Agent for these statistics.

The IP comes from Express's trusted request IP. Configure `TRUST_PROXY` to the
actual reverse-proxy topology and prevent untrusted clients from reaching the
Node.js port directly. Otherwise a proxy address may be recorded, or a forged
forwarded address may be trusted. IP addresses are personal data in many
deployments; restrict administrator access and apply an appropriate retention
policy. These statistics are not suitable for identifying people or billing.

## Errors

Errors use the standard API v1 error envelope. Relevant responses include:

- `401 AUTH_REQUIRED` or `401 TOKEN_INVALID` for missing or invalid access;
- `403 ADMIN_REQUIRED` when the current account is not an administrator;
- `404 PUBLIC_SHARE_NOT_FOUND` for an unknown detail ID;
- `422 VALIDATION_FAILED` for an invalid ID, limit, or unknown parameter;
- `429 RATE_LIMITED` when the enabled instance limiter is exceeded.
