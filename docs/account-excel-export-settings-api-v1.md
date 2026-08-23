# Account Excel Export Settings API v1

This authenticated API stores one Excel-export configuration per account. The
Web portal uses it for collaboration, personal-cloud, and administrator Session
detail exports, so the same account keeps its style across browsers and
devices. Settings are private to the account and are deleted with that account.
The generated `.xlsx` file is produced in the browser and is not retained by
the server.

Both endpoints return `Cache-Control: no-store`:

- `GET /api/v1/account/excel-export-settings`
- `PUT /api/v1/account/excel-export-settings`

Before the first save, GET returns the client-compatible defaults with
`persisted: false` and `updatedAt: null`; it does not create a database row.

~~~json
{
  "excelExportSettings": {
    "formatVersion": 1,
    "headerText": "{yyyy}-{MM}-{dd}日点名记录",
    "useSessionTitleAsHeader": true,
    "useSessionTitleAsFileName": true,
    "headerBackgroundColor": "#1E84D2FF",
    "headerRowBackgroundColor": "#CFE7FFFF",
    "controllerBackgroundColor": "#FFFFC3FF",
    "tableBackgroundColor": "#FFFFFFFF",
    "alternateRowColor": "#C0E5F2FF",
    "useAlternateColors": true,
    "fontFamily": "SarasaGothicSC",
    "showFooter": true,
    "fileNameTemplate": "点名记录_{yyyy}-{MM}-{dd}"
  },
  "persisted": false,
  "updatedAt": null
}
~~~

PUT accepts exactly one `excelExportSettings` object with every field shown
above. Unknown or missing fields are rejected. Colors use `#RRGGBB` or
`#RRGGBBAA`; six-digit input is stored as opaque eight-digit uppercase color.
Text fields are bounded to 200 characters, except `fontFamily` at 100. The
supported template variables are `{yyyy}`, `{MM}`, `{dd}`, `{HH}`, `{mm}`,
`{ss}`, and `{session}`. An identical PUT is idempotent and preserves
`updatedAt`.

The Web export follows the Flutter client layout: 11 data columns, a separate
controller row whenever the contiguous controller block changes, controller
start-time rounding, per-block alternating colors, optional three-line footer,
custom font and colors, and the same session-title/template filename rules.
