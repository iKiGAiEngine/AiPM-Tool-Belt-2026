# AiPM Estimating Integration API

**Base URL:** `https://<your-aipm-host>/api/integration/v1`
**Version:** 1.0.0 · **Format:** JSON in, JSON out (plus one endpoint that returns an `.xlsx` file)

This is the door SharePoint, Power Automate and Copilot use to read and write
AiPM estimates. It is separate from the endpoints the AiPM web app uses for
itself, and it is designed to stay stable so a flow you build today keeps
working after the app changes.

---

## 1. How the pieces fit together

If you only read one section, read this one.

```
   ┌──────────────────────┐        ┌───────────────────┐        ┌─────────────────────┐
   │        AiPM          │        │  Power Automate   │        │  Corporate M365     │
   │  Estimating Module   │        │  (your tenant)    │        │  SharePoint site    │
   │                      │        │                   │        │                     │
   │  • line items        │  API   │  • polls the API  │  M365  │  • Estimates LIST   │
   │  • vendor quotes     │ ─────► │  • maps fields    │ ─────► │  • Estimates LIBRARY│
   │  • markups & totals  │  key   │  • writes to SP   │ creds  │    (the .xlsx files)│
   └──────────────────────┘        └───────────────────┘        └─────────────────────┘
        system of record             the only piece that           where the data has
        for the estimate             holds BOTH credentials        to live for corporate
```

**AiPM never calls SharePoint and never holds a Microsoft credential.** Power
Automate — which already runs inside the corporate tenant, under corporate
identity and corporate policy — pulls from this API and does the writing. That
is deliberate: it is what satisfies the data-isolation requirement. Nothing in
AiPM can reach into the tenant, and the tenant's credentials never leave it.

**Two SharePoint destinations, two different jobs:**

| Destination | Holds | Fed by |
|---|---|---|
| A SharePoint **list** ("Estimates") | One row per estimate — project, estimator, status, total value. The thing people filter, sort and report on. | `GET /estimates/{id}/sharepoint-item` |
| A SharePoint **document library** | The estimate workbook (`.xlsx`) — the full detail, per project. | `GET /estimates/{id}/workbook` or `GET /estimates/{id}/excel-rows` |

### Which Excel endpoint do I want?

There are two ways to "fill out the Excel sheet", and they solve different problems:

- **`GET /estimates/{id}/workbook`** — AiPM builds the whole workbook and hands
  you the finished file. Power Automate saves it to the library. **Use this
  unless you have a reason not to.** It is one action, it cannot get out of
  step, and the sheet comes out identical to the one an estimator downloads
  from the Estimating Module.

- **`GET /estimates/{id}/excel-rows`** — AiPM hands you the same sheets as
  JSON rows, and Power Automate writes them into a workbook that is *already*
  sitting in SharePoint, using the Excel Online connector. Use this when the
  corporate template has formatting, formulas, macros or protected cells that
  must survive — you are filling in an existing sheet rather than replacing it.

---

## 2. Authentication

Every endpoint except `/health` requires an API key.

Send it as a header — either form works:

```
X-API-Key: <your key>
```
```
Authorization: Bearer <your key>
```

### Creating a key

Generate a strong random secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then set it as an environment variable on the AiPM server (in Replit: the
**Secrets** panel — never in a file that gets committed):

```
AIPM_INTEGRATION_API_KEY=<the generated secret>
```

For more than one caller, use `AIPM_INTEGRATION_API_KEYS` with comma-separated
entries so each one is labelled and separately revocable:

```
AIPM_INTEGRATION_API_KEYS=power-automate:write:<secret1>,copilot:read:<secret2>,reporting:read:<secret3>
```

| Entry format | Meaning |
|---|---|
| `<secret>` | Read + write, labelled `default` |
| `<label>:<secret>` | Read + write, labelled `<label>` |
| `<label>:read:<secret>` | **Read only** — GET works, writes return `403 READ_ONLY_KEY` |
| `<label>:write:<secret>` | Read + write |

Secrets must be at least 24 characters; shorter ones are ignored with a warning
in the server log. The label appears on every audit log entry, so you can see
which integration made which change. Revoking a key is just removing it from
the variable and restarting.

**Give each flow the narrowest key it needs.** A flow that only copies data
into SharePoint should hold a `read` key — then a bug in it can never damage
an estimate.

### Other settings

| Variable | Default | What it does |
|---|---|---|
| `AIPM_INTEGRATION_API_KEY` | — | Single key, read + write |
| `AIPM_INTEGRATION_API_KEYS` | — | Multiple labelled keys (above) |
| `AIPM_INTEGRATION_CORS_ORIGINS` | `*` | Comma-separated browser origins allowed to call this API |
| `AIPM_INTEGRATION_RATE_LIMIT` | `300` | Requests per minute, per key |

CORS is enabled on every endpoint. Power Automate *cloud* flows call from
Microsoft's servers, where CORS does not apply at all — it matters for the
browser-side callers: a custom connector's test pane, Copilot Studio, and Power
Apps. Cookies are never accepted, so a wildcard origin cannot be used to ride
somebody's AiPM login.

---

## 3. What an estimate looks like

Two things about AiPM's data are worth understanding before you map fields,
because they explain the shape of everything below.

**The project facts and the pricing live in different places.** The estimate
holds the pricing. The *project* — Self Perform Estimator, GC lead, region,
market, due date, owner, address — lives on the Proposal Log entry the estimate
belongs to. This API joins them for you, so `selfPerformEstimator` and
`totalValue` arrive in the same object. You never have to make two calls.

**The total value is calculated, not stored.** There is no "total" column in
the database. Every dollar figure this API returns is computed from the line
items, the vendor quotes and the markup rates at the moment you ask, by the
exact same code the estimating screen uses (`shared/estimateCalc.ts`). So the
number in SharePoint always matches the number the estimator is looking at.

Two rules inside that math surprise people, so they are worth stating plainly:

- **Fee is grossed up, not marked up.** A 15% fee on a $100 subtotal is
  **$17.65**, not $15.00 — the fee is a percentage *of the selling price*, so
  the selling price has to absorb it (`subtotal ÷ (1 − 0.15)`). Overhead, by
  contrast, is a plain markup. If you ever recalculate a total in Power
  Automate or a SharePoint formula and get a slightly smaller number than
  AiPM, this is why. **Don't recalculate — use `totalValue`.**
- **A lump-sum vendor quote tops its scope up, it never pulls it down.** If a
  vendor quotes one price higher than the line items under it, the difference
  is added. If the line items already exceed it, nothing is subtracted.

### Scope sections

Every line item belongs to a scope section, stored as a short id. The labels
are what people read; the ids are what the API takes.

| `scopeId` | `scopeLabel` | CSI |
|---|---|---|
| `accessories` | Toilet Accessories | 10 28 00 |
| `partitions` | Toilet Compartments | 10 21 00 |
| `fire_ext` | FEC | 10 44 00 |
| `corner_guards` | Wall Protection | 10 26 00 |
| `appliances` | Appliances | 11 31 00 |
| `lockers` | Lockers | 10 51 00 |
| `display_boards` | Visual Displays | 10 11 00 |
| `bike_racks` | Bike Racks | 10 73 00 |
| `wire_mesh` | Wire Mesh Partitions | 10 22 13 |
| `cubicle_curtains` | Cubicle Curtains | 12 48 00 |
| `med_equipment` | Med Equipment | 11 71 00 |
| `expansion_joints` | Expansion Joints | 07 95 00 |
| `storage_units` | Shelving | 10 51 13 |
| `equipment` | Equipment | 11 00 00 |
| `entrance_mats` | Entrance Mats | 12 48 13 |
| `mailboxes` | Mailbox | 10 55 00 |
| `flagpoles` | Flagpole | 10 75 00 |
| `knox_box` | Knox Box | 08 71 13 |
| `site_furnishing` | Site Furnishing | 12 93 00 |
| `uncategorized` | Uncategorized | — |

Rather than copying this table into your flow, call `GET /scopes` and build
your SharePoint Choice column from the response — then it can never drift.

**Vendors belong to quotes, not to line items.** A line item points at a quote
(`quoteId`); the quote carries the vendor name, the freight and any lump-sum
price. For convenience each line item also reports the resolved `vendor` name,
so a SharePoint list can show it without a second lookup.

---

## 4. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check. **No API key required.** |
| `GET` | `/scopes` | The scope catalog above, as data. |
| `GET` | `/estimates` | List estimates. Supports `updatedSince` polling. |
| `GET` | `/estimates/{id}` | One estimate, fully nested, with totals. |
| `POST` | `/estimates` | Create an estimate, optionally with line items. |
| `PUT` | `/estimates/{id}` | Update the estimate and sync its line items. |
| `PATCH` | `/estimates/{id}` | Update estimate fields only. Never touches line items. |
| `DELETE` | `/estimates/{id}` | Delete the estimate and its children. |
| `POST` | `/estimates/{id}/line-items` | Add one line item, or an array of them. |
| `PUT` | `/estimates/{id}/line-items/{itemId}` | Change one line item — e.g. a qty or a cost. |
| `DELETE` | `/estimates/{id}/line-items/{itemId}` | Remove one line item. |
| `GET` | `/estimates/{id}/sharepoint-item` | Flat object shaped for a SharePoint list row. |
| `GET` | `/estimates/{id}/excel-rows` | The workbook as JSON rows, sheet by sheet. |
| `GET` | `/estimates/{id}/workbook` | The workbook as a real `.xlsx` file. |

---

### `GET /health`

No key needed — use it to prove the connection before wiring up credentials.

```json
{ "status": "ok", "api": "aipm-estimating-integration", "version": "1.0.0", "time": "2026-09-12T14:02:11.904Z" }
```

---

### `GET /scopes`

```json
{
  "scopes": [
    { "scopeId": "accessories", "scopeLabel": "Toilet Accessories", "csiCode": "10 28 00" },
    { "scopeId": "partitions",  "scopeLabel": "Toilet Compartments", "csiCode": "10 21 00" }
  ]
}
```

---

### `GET /estimates`

| Query parameter | Default | Notes |
|---|---|---|
| `updatedSince` | — | ISO 8601 timestamp. Only estimates changed since then. **This is what makes polling work.** |
| `reviewStatus` | — | e.g. `drafting`, `in_review`, `final` |
| `estimateNumber` | — | Exact match on the PV number |
| `proposalLogId` | — | All estimates under one proposal log entry |
| `includeTest` | `false` | Set `true` to include estimates flagged as test data |
| `limit` | `50` | 1–200 |
| `offset` | `0` | For paging |

```
GET /api/integration/v1/estimates?updatedSince=2026-09-11T00:00:00Z&limit=50
X-API-Key: <your key>
```

```json
{
  "estimates": [
    {
      "estimateId": 142,
      "proposalLogId": 318,
      "estimateNumber": "PV-2026-0142",
      "projectName": "Mercy General — Tower C Renovation",
      "selfPerformEstimator": "Dana Whitfield",
      "nbsEstimator": "Gonzalo Ruiz",
      "gcEstimateLead": "Swinerton — R. Alvarez",
      "region": "Northern California",
      "primaryMarket": "Healthcare",
      "owner": "Mercy Health",
      "dueDate": "2026-10-03",
      "projectAddress": "4001 J St, Sacramento, CA",
      "squareFeet": "184000",
      "proposalStatus": "Bidding",
      "reviewStatus": "in_review",
      "isTest": false,
      "activeScopes": ["accessories", "partitions", "fire_ext"],
      "activeScopeLabels": ["Toilet Accessories", "Toilet Compartments", "FEC"],
      "lineItemCount": 47,
      "totalValue": 284416.92,
      "createdBy": "gruiz@nbs.com",
      "createdAt": "2026-08-14T17:22:04.118Z",
      "updatedAt": "2026-09-12T13:58:41.002Z"
    }
  ],
  "pagination": { "total": 1, "limit": 50, "offset": 0, "returned": 1, "hasMore": false },
  "polledAt": "2026-09-12T14:02:11.904Z"
}
```

`polledAt` is the server's clock at the moment the page was built. Store it and
pass it back as the next run's `updatedSince` — that way you are never doing
timezone math against your own clock, and nothing slips through a gap.

---

### `GET /estimates/{id}`

The full document: header, markup rates, estimate-wide totals, per-scope
totals, every line item, every vendor quote, breakouts, assumptions and risks.

```json
{
  "estimateId": 142,
  "estimateNumber": "PV-2026-0142",
  "projectName": "Mercy General — Tower C Renovation",
  "selfPerformEstimator": "Dana Whitfield",
  "reviewStatus": "in_review",
  "totalValue": 284416.92,

  "rates": { "overheadPct": 8, "feePct": 15, "escalationPct": 3, "taxPct": 8.75, "bondPct": 0 },

  "totals": {
    "material": 198450.00, "escalation": 5953.50, "freight": 4200.00,
    "subtotal": 208603.50, "overhead": 16688.28, "fee": 36812.38,
    "tax": 22312.76, "bond": 0, "totalValue": 284416.92
  },

  "scopeTotals": [
    {
      "scopeId": "accessories", "scopeLabel": "Toilet Accessories", "csiCode": "10 28 00",
      "itemCount": 28, "material": 84200.00, "escalation": 2526.00, "freight": 1800.00,
      "subtotal": 88526.00, "overhead": 7082.08, "fee": 15622.24,
      "tax": 7367.50, "bond": 0, "total": 118597.82,
      "overheadPct": 8, "feePct": 15, "escalationPct": 3,
      "hasRateOverride": false, "isComplete": true, "missingBackupCount": 0
    }
  ],

  "lineItems": [
    {
      "lineItemId": 9871, "scopeId": "accessories", "scopeLabel": "Toilet Accessories",
      "csiCode": "10 28 00", "planCallout": "TA-1", "name": "Surface Mounted Paper Towel Dispenser",
      "model": "B-262", "manufacturer": "Bobrick", "qty": 42, "uom": "EA",
      "unitCost": 148.50, "extendedCost": 6237.00, "escalationOverridePct": null,
      "quoteId": 512, "vendor": "Page Specialty", "source": "vendor_quote",
      "note": null, "hasBackup": true, "sortOrder": 0
    }
  ],

  "quotes": [
    {
      "quoteId": 512, "scopeId": "accessories", "scopeLabel": "Toilet Accessories",
      "vendor": "Page Specialty", "pricingMode": "per_item", "freight": 1800.00,
      "lumpSumTotal": 0, "taxIncluded": false, "hasBackup": true,
      "note": "Quote #PS-88213, valid 30 days", "itemCount": 28,
      "quoteTotal": 84200.00, "status": "approved"
    }
  ],

  "breakouts": [],
  "assumptions": ["All items are FURNISH ONLY — installation by others"],
  "risks": ["Lead times may extend beyond anticipated start date"],
  "qualificationsByScope": {},
  "latestVersion": { "version": 6, "savedBy": "gruiz@nbs.com", "savedAt": "2026-09-12T13:58:40.981Z", "grandTotal": 284416.92, "notes": "Added Bradley alternate" }
}
```

---

### `POST /estimates`

Creates an estimate. Only `estimateNumber` and `projectName` are required.

```json
{
  "estimateNumber": "PV-2026-0198",
  "projectName": "Sutter Health — Roseville MOB",
  "selfPerformEstimator": "Dana Whitfield",
  "nbsEstimator": "Gonzalo Ruiz",
  "gcEstimateLead": "Swinerton — R. Alvarez",
  "region": "Northern California",
  "primaryMarket": "Healthcare",
  "dueDate": "2026-11-14",
  "activeScopes": ["accessories", "fire_ext"],
  "rates": { "overheadPct": 8, "feePct": 15, "escalationPct": 3, "taxPct": 7.75, "bondPct": 0 },
  "createdBy": "power-automate",
  "lineItems": [
    { "scopeId": "accessories", "name": "Grab Bar 36\"", "model": "B-6806x36", "manufacturer": "Bobrick", "qty": 64, "unitCost": 42.75, "planCallout": "TA-4" },
    { "scopeId": "fire_ext", "name": "Semi-Recessed FEC", "model": "JL-1017F10", "manufacturer": "JL Industries", "qty": 12, "unitCost": 218.00 }
  ]
}
```

Returns **201** with the full estimate document (totals already calculated).

Two behaviours worth knowing:

- **`proposalLogId` is optional.** Leave it out and AiPM opens a **draft**
  Proposal Log entry for the project from the fields you sent, marked with
  source `integration_api`, so the estimate still shows up where estimators
  expect it and a human can confirm the project details. Pass an existing
  `proposalLogId` to attach to a project already in the log.
- **Repeat POSTs are safe.** An estimate is one-per-project. If one already
  exists for that proposal log entry, you get **200** and the existing
  estimate back instead of a duplicate — so a Power Automate run that retries
  after a timeout cannot create two.

Defaults when omitted: overhead 8%, fee 15%, escalation 0%, tax 0%, bond 0%,
`reviewStatus` `drafting`, `qty` 1, `uom` `EA`, `unitCost` 0, `source`
`power_automate`.

Numbers may be sent as numbers or as strings — `"1,250.00"` and `"$1250"` both
parse, which saves fighting with SharePoint's currency columns.

---

### `PUT /estimates/{id}` — update, and sync line items

Send only what changes. Everything is optional.

```json
{
  "rates": { "escalationPct": 4.5 },
  "reviewStatus": "in_review",
  "lineItems": [
    { "lineItemId": 9871, "scopeId": "accessories", "name": "Surface Mounted Paper Towel Dispenser", "qty": 48, "unitCost": 152.00 },
    { "scopeId": "accessories", "name": "Mirror 18x36", "manufacturer": "Bobrick", "qty": 22, "unitCost": 96.40 }
  ],
  "lineItemMode": "merge",
  "updatedBy": "power-automate"
}
```

**`lineItemMode` decides what happens to items you did not send:**

| Mode | Behaviour |
|---|---|
| `merge` *(default)* | Items with a `lineItemId` are updated. Items without one are inserted. **Anything not mentioned is left alone.** Safe to retry. |
| `replace` | Same as merge, **and every line item not in the payload is deleted** so the estimate matches your payload exactly. |

Use `merge` unless you are deliberately mirroring a full list from SharePoint.
A `lineItemId` belonging to a different estimate is rejected before anything is
written, so a mistyped id can never move another project's row.

You can also set per-scope rate overrides:

```json
{ "scopeRateOverrides": { "lockers": { "oh": 10, "fee": 18 } } }
```

Send `{ "lockers": {} }` to clear a scope's overrides and put it back on the
estimate defaults.

### `PATCH /estimates/{id}`

Identical body, but **line items are rejected**. Use it when a flow should only
ever touch header fields — then a bug in it cannot delete pricing. Sending
`lineItems` to PATCH returns `400 LINE_ITEMS_NOT_ALLOWED`.

---

### `DELETE /estimates/{id}`

Deletes the estimate and all of its children: line items, vendor quotes and
their parsed rows, breakouts and allocations, spec sections, approved
manufacturers, review comments, version history, OH approvals and the RFQ log.

**The Proposal Log entry is deliberately kept** — it is the project's record
and usually predates the estimate.

```json
{
  "deleted": true, "estimateId": 142, "estimateNumber": "PV-2026-0142",
  "projectName": "Mercy General — Tower C Renovation", "proposalLogId": 318,
  "note": "The proposal log entry for this project was kept."
}
```

This cannot be undone from the API. Give delete rights only to a key that needs
them, and consider setting `reviewStatus` instead of deleting.

---

### Line item endpoints

For flows that react to a single SharePoint row changing rather than syncing a
whole estimate. This is the "adjust a quantity or a cost" path.

**`POST /estimates/{id}/line-items`** — one item, or `{ "lineItems": [ ... ] }`
for several:

```json
{ "scopeId": "lockers", "name": "Single Tier Locker 12x18x72", "manufacturer": "Penco", "qty": 120, "unitCost": 214.00, "hasBackup": true }
```

**`PUT /estimates/{id}/line-items/{itemId}`** — change just what you send:

```json
{ "qty": 130, "unitCost": 219.50 }
```

**`DELETE /estimates/{id}/line-items/{itemId}`** — remove one row.

All three return the recalculated estimate summary, so your flow sees the new
`totalValue` without a second call:

```json
{ "updated": 9871, "estimate": { "estimateId": 142, "totalValue": 291204.18, "lineItemCount": 48, "...": "..." } }
```

---

### `GET /estimates/{id}/sharepoint-item`

One flat object, no nesting, with PascalCase keys that drop straight into
SharePoint's **Create item** / **Update item** actions.

```json
{
  "Title": "Mercy General — Tower C Renovation",
  "EstimateId": 142,
  "EstimateNumber": "PV-2026-0142",
  "ProposalLogId": 318,
  "ProjectName": "Mercy General — Tower C Renovation",
  "SelfPerformEstimator": "Dana Whitfield",
  "NBSEstimator": "Gonzalo Ruiz",
  "GCEstimateLead": "Swinerton — R. Alvarez",
  "Region": "Northern California",
  "PrimaryMarket": "Healthcare",
  "Owner": "Mercy Health",
  "DueDate": "2026-10-03",
  "ProjectAddress": "4001 J St, Sacramento, CA",
  "SquareFeet": "184000",
  "ReviewStatus": "in_review",
  "ProposalStatus": "Bidding",
  "ScopeSections": "Toilet Accessories; Toilet Compartments; FEC",
  "LineItemCount": 47,
  "MaterialCost": 198450.00,
  "Freight": 4200.00,
  "Escalation": 5953.50,
  "Subtotal": 208603.50,
  "Overhead": 16688.28,
  "Fee": 36812.38,
  "Tax": 22312.76,
  "Bond": 0,
  "TotalValue": 284416.92,
  "OverheadPct": 8, "FeePct": 15, "EscalationPct": 3, "TaxPct": 8.75, "BondPct": 0,
  "IsTest": false,
  "CreatedBy": "gruiz@nbs.com",
  "CreatedAt": "2026-08-14T17:22:04.118Z",
  "UpdatedAt": "2026-09-12T13:58:41.002Z"
}
```

#### Suggested SharePoint list columns

| Column | Type | Notes |
|---|---|---|
| Title | Single line of text | Project name |
| EstimateId | Number | **Make this unique and index it** — it is the join key |
| EstimateNumber | Single line of text | PV number |
| SelfPerformEstimator | Single line of text | Or a Person column if these are staff |
| NBSEstimator | Single line of text | |
| GCEstimateLead | Single line of text | |
| Region / PrimaryMarket | Choice | |
| DueDate | Date | |
| ReviewStatus | Choice | drafting / in_review / final |
| ScopeSections | Multiple lines of text | Semicolon separated |
| TotalValue | Currency | The headline number |
| MaterialCost / Freight / Overhead / Fee / Tax / Bond | Currency | Optional breakdown |
| LineItemCount | Number | |
| UpdatedAt | Date and Time | Drives "what changed" views |
| WorkbookUrl | Hyperlink | Fill in after saving the file — see §5 |

> **Where does the link between an AiPM estimate and its SharePoint file live?**
> In the SharePoint list, not in AiPM. Store `EstimateId` and `WorkbookUrl` as
> columns on the list item. That keeps corporate data in the corporate tenant —
> AiPM never learns your SharePoint URLs — and it means the mapping is visible
> and fixable by anyone with access to the list.

---

### `GET /estimates/{id}/excel-rows`

The workbook as JSON, sheet by sheet — for writing into an existing SharePoint
workbook with the Excel Online connector.

Add `?sheet=Line%20Items` to fetch a single sheet.

```json
{
  "estimateId": 142,
  "estimateNumber": "PV-2026-0142",
  "projectName": "Mercy General — Tower C Renovation",
  "workbookFilename": "PV-2026-0142_Estimate_2026-09-12.xlsx",
  "generatedAt": "2026-09-12T14:02:11.904Z",
  "sheets": [
    {
      "sheetName": "Line Items",
      "columns": ["Scope Section", "CSI Code", "Item Name", "Model", "Manufacturer", "Qty", "Unit Cost", "Extended", "Quote Vendor", "Source", "Has Backup", "Qualification", "Plan Callout"],
      "rows": [
        ["Toilet Accessories", "10 28 00", "Surface Mounted Paper Towel Dispenser", "B-262", "Bobrick", 42, 148.5, 6237, "Page Specialty", "vendor_quote", "Yes", "", "TA-1"]
      ],
      "records": [
        {
          "Scope Section": "Toilet Accessories", "CSI Code": "10 28 00",
          "Item Name": "Surface Mounted Paper Towel Dispenser", "Model": "B-262",
          "Manufacturer": "Bobrick", "Qty": 42, "Unit Cost": 148.5, "Extended": 6237,
          "Quote Vendor": "Page Specialty", "Source": "vendor_quote",
          "Has Backup": "Yes", "Qualification": "", "Plan Callout": "TA-1"
        }
      ]
    }
  ]
}
```

Each sheet arrives twice, deliberately:

- **`rows`** — positional arrays, for writing to a cell range.
- **`records`** — objects keyed by column header, for **Add a row into a
  table**, which wants named columns. Use these unless you are targeting a
  specific range.

Sheets returned: `Summary`, `Line Items`, `Vendor Quotes`,
`Markups by Category`, `Breakouts` (only when the estimate has breakout
groups), `Assumptions & Risks`, `Spec Sections` (only when present), and
`Version History`. Key/value sheets like `Summary` have `"columns": null` and
`"records": null` — read their `rows` as label/value pairs.

---

### `GET /estimates/{id}/workbook`

The `.xlsx` file itself, laid out exactly like the one an estimator downloads
from the Estimating Module. Currency cells are formatted as currency and
percentage cells as percentages — it opens looking like a finished estimate,
not a data dump.

By default the response body **is** the file:

```
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="PV-2026-0142_Estimate_2026-09-12.xlsx"
```

Feed that body straight into SharePoint's **Create file** action as File
Content.

Add `?encoding=base64` if your connector needs a JSON envelope instead:

```json
{
  "filename": "PV-2026-0142_Estimate_2026-09-12.xlsx",
  "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "$content": "UEsDBBQABgAIAAAAIQ...",
  "byteLength": 28411
}
```

---

## 5. Building the Power Automate flows

### Flow 1 — Keep a SharePoint list in step with AiPM

The API has no webhooks, so a scheduled poll is the trigger. `updatedSince`
makes it behave like one.

1. **Recurrence** — every 15 minutes (or whatever suits).
2. **Initialize variable** `lastPolled`, type String. On the first run use a
   date far enough back to pick up everything you care about; after that, read
   it from wherever you stored it in step 6.
3. **HTTP** action:
   - Method `GET`
   - URI `https://<aipm-host>/api/integration/v1/estimates?updatedSince=@{variables('lastPolled')}&limit=200`
   - Headers: `X-API-Key` → your key (from **Azure Key Vault**, not typed into the flow)
4. **Parse JSON** on the response body.
5. **Apply to each** over `estimates`:
   - **Get items** from the Estimates list, filter query `EstimateId eq @{items('Apply_to_each')?['estimateId']}`
   - **Condition** — did that return anything?
     - **Yes** → **Update item** with the current values
     - **No** → **Create item**
   - For the field values, call `GET /estimates/{id}/sharepoint-item` and map
     its keys straight across — they already match the column names above.
6. **Set variable** `lastPolled` to the response's `polledAt`, and persist it
   (a one-row SharePoint list, or an environment variable) so the next run
   picks up where this one stopped.

> **Don't use `utcNow()` for `lastPolled`.** Use the `polledAt` the API
> returned. It comes from the same clock the data does, so nothing can slip
> through the gap between your flow's clock and the server's.

### Flow 2 — Put the workbook in the document library

Extend Flow 1, or run it on demand:

1. **HTTP** `GET /api/integration/v1/estimates/@{item()?['estimateId']}/workbook`
   with the `X-API-Key` header.
2. **Create file** (SharePoint):
   - Folder path: your Estimates library
   - File name: `@{body('Parse_JSON')?['estimateNumber']}.xlsx`
   - File content: the **Body** of the HTTP action
3. **Update item** — write the new file's `Path` into the list item's
   `WorkbookUrl` column, so the list row links to its workbook.

Re-running this overwrites the file with a freshly built one, which is normally
what you want. If people edit the workbook in SharePoint by hand, write to a
versioned name (`PV-2026-0142_v7.xlsx`) or use the `excel-rows` approach below
instead — otherwise their edits get overwritten on the next run.

### Flow 3 — Fill a corporate template in place

When the workbook must keep its own formatting, formulas or protected cells:

1. **HTTP** `GET /estimates/{id}/excel-rows?sheet=Line Items`
2. **Apply to each** over `sheets[0].records`
3. **Excel Online (Business) → Add a row into a table**, pointing at the table
   in the SharePoint-hosted workbook. The record keys already match the column
   headers, so the mapping is one-to-one.

The table must already exist in the workbook with matching headers — Excel
Online can only add rows to a defined table, not create one. Clear the table's
existing rows first if you are replacing rather than appending.

### Flow 4 — Push an edit from SharePoint back into AiPM

1. **When an item is created or modified** in your Estimates list.
2. **Condition** — guard against loops: skip if `Modified By` is the service
   account your sync flow runs as, otherwise Flow 1 and Flow 4 will trigger
   each other forever.
3. **HTTP** `PATCH /api/integration/v1/estimates/@{triggerBody()?['EstimateId']}`
   with a body carrying only the fields a person is allowed to change from
   SharePoint, e.g.
   `{ "reviewStatus": "@{triggerBody()?['ReviewStatus']}", "updatedBy": "sharepoint" }`

Use `PATCH`, not `PUT`, for this direction. PATCH cannot touch line items, so a
misconfigured flow can change a status but can never delete pricing.

### Notes for Copilot / Copilot Studio

Build a **custom connector** from this API and Copilot can answer questions
against live estimating data. Two rules make that behave:

- Give the connector a **read-only key**. A question-answering agent should
  never be able to change an estimate.
- Point it at `GET /estimates` and `GET /estimates/{id}`, and let it use
  `totalValue` as returned. Don't let it add markups up itself — see the
  grossed-up fee note in §3.

---

## 6. Errors

Every failure returns the same shape, so a flow can branch on
`body.error.code` instead of reading prose:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The estimate payload is not valid.",
    "details": [
      { "field": "lineItems.0.qty", "message": "Expected a number" }
    ]
  }
}
```

| Status | Code | Meaning and fix |
|---|---|---|
| 400 | `INVALID_ID` | The id in the path is not a positive whole number. |
| 400 | `INVALID_PARAMETER` | A query parameter is malformed — usually `updatedSince` not being ISO 8601. |
| 400 | `LINE_ITEMS_NOT_ALLOWED` | You sent line items to `PATCH`. Use `PUT`. |
| 400 | `NO_FIELDS` | The update body had nothing updatable in it. |
| 401 | `MISSING_API_KEY` | No `X-API-Key` header. |
| 401 | `INVALID_API_KEY` | The key is not recognized — check for whitespace, and that the server was restarted after the secret was set. |
| 403 | `READ_ONLY_KEY` | This key may only read. Use a `write` key. |
| 404 | `ESTIMATE_NOT_FOUND` / `LINE_ITEM_NOT_FOUND` | No such record. It may have been deleted. |
| 404 | `SHEET_NOT_FOUND` | The `?sheet=` name does not exist. The message lists the valid ones. |
| 404 | `ENDPOINT_NOT_FOUND` | Path typo. |
| 409 | `LINE_ITEM_ESTIMATE_MISMATCH` | That line item belongs to a different estimate. |
| 422 | `VALIDATION_FAILED` | Body failed validation. `details` names each bad field. |
| 422 | `UNKNOWN_SCOPE` | A `scopeId` is not in the catalog. `GET /scopes` for the valid list. |
| 422 | `PROPOSAL_LOG_NOT_FOUND` | The `proposalLogId` does not exist. Omit it to have one created. |
| 422 | `LINE_ITEM_NOT_ON_ESTIMATE` | A `lineItemId` in the payload belongs to a different estimate. Nothing was written. |
| 429 | `RATE_LIMITED` | Over the per-minute limit. The `Retry-After` header says how long to wait. |
| 500 | `INTERNAL_ERROR` | Something broke server-side. Check the AiPM server log. |

In Power Automate, set **Configure run after** on the step following an HTTP
action so failures are handled rather than silently ending the run. For `429`,
add a **Delay** using the `Retry-After` header and retry.

---

## 7. Security notes

- **Keys are secrets.** Store them in Azure Key Vault and reference them from
  the flow. Never type a key into a flow action, a connector definition, or any
  file in this repository.
- **Least privilege.** Read-only keys for anything that only reports or
  answers questions; write keys only where a flow genuinely has to change data.
- **Everything is audited.** Every write records the key's label, the IP, the
  path and a summary in AiPM's audit log, visible on the Audit Log page.
- **Rate limited** per key, default 300 requests/minute.
- **No cookies, ever.** This API never reads or sets a session cookie, so it
  cannot be driven from a logged-in user's browser session.
- **Rotating a key**: add the new key alongside the old one, move the flows
  over, then remove the old one and restart. No downtime.
- **This API does not serve quote backup files or uploaded PDFs.** Only
  estimating data crosses the line. Documents stay in AiPM.

---

## 8. Where the code lives

| File | What it does |
|---|---|
| `server/integration/routes.ts` | The endpoints, validation and audit logging |
| `server/integration/security.ts` | API key auth, CORS, rate limiting, error envelope |
| `server/integration/estimateResource.ts` | Joins the tables and shapes the JSON |
| `server/integration/workbook.ts` | Builds the workbook, as a file and as rows |
| `shared/estimateCalc.ts` | **The totals math — the single source of truth** |
| `shared/estimateScopes.ts` | The scope catalog |

`shared/estimateCalc.ts` and `shared/estimateScopes.ts` are also what the
estimating screen itself uses. That is on purpose: it is why the number in
SharePoint is always the number on the estimator's screen. If you ever need to
change how a total is calculated, change it there and everything moves
together — never re-implement the math in a flow or a SharePoint formula.
