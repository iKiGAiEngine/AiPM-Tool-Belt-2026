# Submittal Builder — Audit & Remediation Plan

**Date:** 2026-07-30
**Scope:** `client/src/submittal-builder/**` (15 files, ~1,450 lines) plus its wiring in
`client/src/App.tsx`, `client/src/pages/HomePage.tsx`, `server/permissionsInit.ts`.
**Method:** full code read, plus a behavior harness driving the real parser, pagination and
validation code against synthetic-but-realistic NBS estimate workbooks
(`scripts/test-submittal-logic.ts` — run with `npx tsx scripts/test-submittal-logic.ts`).

**Harness result at time of audit: 14 of 29 checks fail.**

## Context: this module is a ported prototype

`attached_assets/Pasted--Replit-Build-Prompt-AiPM-Submittal-Builder-*.txt` is the original build prompt.
It specified: *"Do not add a backend server… Do not create a server, API, or backend of any
kind… Persistence uses localStorage… Do not create any test files."* The module was later
ported into this TypeScript app essentially verbatim.

That explains nearly every finding below. The prototype's stubs — fake attachment page
counts, no file storage, no export, browser-only persistence — were never replaced. It looks
finished, which is the dangerous part: a PM can complete the whole flow and end up with a
transmittal full of fabricated page numbers and no output file.

---

## P0 — Wrong or lost data

### 1. Scope tabs are silently dropped based on column spelling
`estimateParser.findHeaderRow` matches a description column with
`h.startsWith("desc")` after stripping non-alphanumerics. `"Item Description"` normalizes to
`itemdescription`, which does not *start with* `desc`, so no description column is found, so
the sheet is not recognized as a scope, so **the entire scope is discarded with no error**.

Harness result across seven real-world header spellings:

| Header row | Result |
|---|---|
| `Item / Description / Model / Qty` | parsed |
| `Item / Item Description / Model No. / Qty` | **scope dropped** |
| `Callout / Product Description / Model Number / Quantity` | **scope dropped** |
| `Tag / Desc / Model / Qty` | parsed |
| `Mark / Description of Work / Catalog No. / Qty` | parsed, but callout blank |
| `No. / Item Description / Manufacturer / Model / Total Qty` | **scope dropped** |
| `Callout / Description / Model / Qty / Unit Price / Total` | parsed |

This is the most damaging defect in the module: silent, and it destroys the PM's starting
data. Related: `"Mark"` is not in the callout synonym list, `"Quantity"` only matches via
`startsWith`, and `"total"` *is* a qty synonym — on a sheet whose only matching header is a
`Total` price column, quantities are read from the price column.

### 2. Non-scope sheets are imported as fake scopes
The module keeps its own `SKIP_SHEETS` set. Against a realistic workbook, `Buyout`,
`Bobrick Material Pricing 2025`, `Proposal` and `PO Review` all became scopes with junk line
items, while the real `Toilet Accessories` tab was dropped (finding 1).

`shared/buyout/canonicalScopes.ts` already exports `isNonScopeSheet()` whose
`NON_SCOPE_SHEET_NAMES` set contains those exact sheet names, and `resolveScope()` for
alias/CSI-aware scope naming. The Buyout module uses them; this module reimplements a worse
version.

### 3. Footer rows become line items
Rows below the table (`MATERIAL SUBTOTAL`, `FREIGHT`, `SALES TAX`, `GRAND TOTAL`) have text
in the description column, so they are ingested as schedule lines and printed on the
submittal. Parsing runs to the last row of the sheet with no terminator.

### 4. The wrong text is printed in SPEC TITLE
`extractCsiAndTitle` takes "the first cell above the header row longer than 8 characters that
doesn't start with a digit" as the spec title. On a sheet with a letterhead row, that is the
company name. Verified: a tab with `National Building Specialties` in row 1 and
`10 28 00 / Toilet Accessories` in row 2 yields `specTitle: "National Building Specialties"`
— which then prints in the SPEC TITLE column of every schedule page sent to the GC.

CSI detection is also hardcoded to Division 10 (`/^10[\s\-]?\d{2}/`), so Division 8/12 scopes
(e.g. window treatments) never resolve a CSI, and nothing falls back to the tab name.

### 5. Every page number on the transmittal is fabricated
`helpers.placeholderPageCount()` returns the constant `2`. Every attached PDF is recorded as
exactly 2 pages, and all cover-page references ("Pages 3–14") are derived from that constant.
The pagination math in `pagination.ts` is correct — its input is fake.

### 6. Attached PDFs are never stored
`ProductDataPanel.addAttachment` records `file.name` and discards the file. There is no
file-type validation (a `.docx` or `.jpg` is accepted as product data), and `matchStatus` is
hardcoded `"exact"` so the UI always shows a green **EXACT** badge regardless of whether the
filename has anything to do with the line's model number.

### 7. "Generate Final Package" produces no file
It flips status and flashes *"PDF generation is a Phase 2 feature."* `pdf-lib`, `pdfjs-dist`
and `jspdf` are all already dependencies.

### 8. …and the `exported` status does not even persist
`PreviewExport.exportPackage` sets `submittalStatus = "exported"` through `update()`, which
calls `Workspace.triggerSave`, which unconditionally re-derives `submittalStatus` and
overwrites it. `ready_for_export` in `STATUS_META` is unreachable dead state.

### 9. Completion ignores line status, so finished packages never read as finished
`Workspace.triggerSave` derives completion purely from "does this line have an attachment",
ignoring `lineStatus`. Lines legitimately marked **By Others** or **Not Required** count as
incomplete. Verified: a package where every line is resolved (2 by-others, 20 attached)
reports **91% / "Waiting on Product Data"** and can never reach *Ready for Review*.

`validation.ts` gets this right (it early-returns on those statuses). The two disagree, so
the Validation tab says "0 missing" while the header says "Waiting on Product Data".

### 10. The same completion math exists three times, differently
`Workspace.triggerSave`, `Dashboard` (its own inline `comp`) and `validation.ts` each compute
completion with different rules. `project.completionPercent` is persisted and then ignored by
the Dashboard, which recomputes it.

### 11. Silent save failure
`storage.setItem` swallows the exception and returns `false`; `saveProject` ignores the return
value; the UI shows **✓ Saved**. On `QuotaExceededError` (5–10 MB per origin — which storing
real PDFs would hit immediately) the PM's work is discarded while the UI reports success.

### 12. "Save Draft" does not save
It calls `triggerSave(project)`, which *restarts* the 800 ms debounce, then immediately
flashes "Saved".

### 13. Edits within 800 ms of navigating away are lost
`saveTimer` is never flushed or cleared on unmount, and there is no `beforeunload` guard.
Pressing back also calls `refreshProjects()` *before* the pending write lands, so the
Dashboard shows stale scope/line counts.

### 14. Validation crashes on a scope with no `lines` array
`validation.ts` calls `scope.lines.forEach` unguarded while every other file guards `s.lines`.
Any legacy or partially-written project record takes down the Validation tab.

### 15. A bad estimate file fails silently
`parseEstimateWorkbook(file).then(...)` in `Workspace.handleEstimateDrop` has no `.catch`.
A corrupt, password-protected or wrong-format file leaves "Parsing estimate workbook…" on
screen and nothing else ever happens. The parser also reports nothing about which sheets it
skipped and why.

---

## P1 — Usability blockers for a new user

### 16. Drag-and-drop is the only input path
Both the estimate import and every product-data attachment are drop-only — no file picker.
Users on touch devices, users driving by keyboard, and anyone whose file lives in a dialog
rather than a window cannot use the module at all.

### 17. A bad parse cannot be corrected
The estimate drop zone renders only when `scopes.length === 0`. Once anything imports, there
is no way to re-import, replace the workbook, or add/rename/delete a scope. The only recovery
is deleting the project and starting over.

### 18. The flow gives a new user no direction
A new project opens on a flat five-tab bar (Schedule / Product Data / Cover Page / Validation
/ Preview) with no indication of order, no "what's next", and no completion signal per step.
Nothing explains that Product Data is the actual work, or that Cover Page can be
auto-generated.

### 19. Validation output is unusable at real scale
`validateProject` emits one warning *per line* for missing product data, blank model and zero
qty. A 60-line scope produces **180 warnings**; the panel truncates at 20 and appends
"+160 more". There is no single "ready / not ready" verdict, no grouping, and no way to jump
from an issue to the line. Blank callout is classified as a hard **error** although it is
common and harmless in real estimates.

### 20. It is not clear the PM is building one package per scope
Cover pages, pagination and preview are all per-scope: each scope is its own document
numbered from page 1. (That is arguably correct — submittals go out per spec section — and
the projected-page math is consistent with it.) But the UI never says so: Preview shows only
the active scope, and a single "Generate Final Package" button implies one combined file.

### 21. Status chips are dark-theme-only
`STATUS_META`, `LINE_STATUS`, `ValidationPanel` and the toast use hardcoded hex
(`#1e293b`, `#422006`, `#3b0764`, …) while the rest of the module uses the app's CSS
variables. The app's default theme is light (`:root` in `client/src/index.css`), so status
chips render as dark blocks with low-contrast text.

### 22. Read-only mode silently discards a viewer's work
`Dashboard` disables New/Delete for viewers, but in the Workspace every input stays editable
and `triggerSave` no-ops with `setSaving("saved")`. A viewer can type into the whole schedule
and watch **✓ Saved** while nothing persists.

### 23. Not accessible, not testable
No `data-testid` anywhere, though the repo has a Playwright suite and uses testids elsewhere.
Project rows are `<div onClick>` with no `role`/`tabIndex`/keyboard handler; inputs have no
labels or `aria-label`; delete uses `window.confirm` instead of the app's dialog component.

### 24. Smaller correctness/consistency issues
- `ProductDataPanel` header reads `"N sheets attached · Pages {first.startPage}–{total} of {total}"` — mislabeled and mixes an attachment start page with the document total.
- `validation.ts` hardcodes `15` instead of importing `LINES_PER_SCHEDULE_PAGE`.
- Two id schemes: `helpers.uid()` (module counter seeded from `Date.now()`, collides across reloads) and `crypto.randomUUID()` in `SubmittalBuilderPage`.
- `parseEstimateWorkbook` reads the project name from the Summary sheet and the caller throws it away.
- `sortOrder` is written on every line but never editable — no reordering.
- `Workspace.update` calls `triggerSave` (which calls `setSaving`) from *inside* the `setProject` updater — an impure updater that sets state during render; double-invoked under StrictMode.
- `Dashboard` filter calls `p.projectName.toLowerCase()` unguarded.
- `triggerSave`'s `useCallback` omits `isViewer` from its deps.

---

## P2 — Platform / architecture

### 25. `/submittal-builder` has no route-level permission gate
`server/permissionsInit.ts` deliberately removes the `submittal-builder` feature from
Estimator accounts, and `HomePage` hides the tile — but `client/src/App.tsx` registers the
route unguarded, so the URL still works for anyone signed in. (Systemic in `App.tsx`: only
`/admin/*` and `/settings` are gated. Fixing it module-wide is out of this audit's scope.)

### 26. All submittal data lives in `localStorage`
Every project, scope, line and attachment record is stored under `submittal:<id>` in the
browser. Consequences: not shared with the team, invisible on another machine or browser,
gone when the cache is cleared, absent from the nightly Postgres backup
(`server/nightlyBackup.ts`), and capped at the ~5 MB origin quota. Every other module in the
suite persists server-side.

This is the one item that is a product decision rather than a bug fix — it needs a call on
schema and multi-user semantics (who owns a submittal, can two PMs edit one, does it link to
the proposal/project record). Flagged for decision, not changed unilaterally.

---

## Remediation plan

Ordered so that each phase is independently shippable and verifiable.

### Phase 1 — Trustworthy import (findings 1–4, 15)
Rewrite `estimateParser` header detection as **best-scoring row** rather than first match:
scan the first ~25 rows, score each against a synonym table, require a description column plus
one other, prefer the highest-scoring row. Substring matching with specificity ordering, so
`Item Description`, `Product Description`, `Description of Work` and `Mark` all resolve; drop
`total` from qty synonyms and add `total qty`. Terminate the row scan on a run of blank rows
and filter footer keywords. Replace the local `SKIP_SHEETS` with
`isNonScopeSheet()`/`resolveScope()` from `shared/buyout/canonicalScopes` and reverse-map
`DEFAULT_SCOPES` (`shared/schema.ts`) for CSI + spec title, falling back to the tab name.
Return a `skipped: Array<{sheet, reason}>` and surface it in the UI, with `.catch` on the
parse.

### Phase 2 — Real files, real pages, real output (findings 5–8)
Store dropped PDFs as blobs in IndexedDB keyed by attachment id (localStorage cannot hold
them); read the true page count with `pdf-lib`; validate file type; derive `matchStatus` from
an actual filename↔model comparison; delete blobs with their attachment/project. Then make
**Generate Final Package** build a real PDF — cover transmittal, schedule pages, each
attachment merged in order with its callout stamped on the first page — and download it, with
pagination derived from the generated document so the cover references are true.

### Phase 3 — One source of truth for state (findings 9–14, 24)
Extract completion/status derivation into a pure `derive.ts` used by Workspace, Dashboard and
Validation; treat `not_required` and `by_others` as resolved; make `ready_for_export`
reachable and stop clobbering `exported`. Surface storage failures as errors. Make Save Draft
flush the debounce; flush on unmount and guard `beforeunload`. Move `triggerSave` out of the
`setProject` updater. Null-guard validation and Dashboard search. Single id scheme.

### Phase 4 — Simplify the flow (findings 16–23)
A guided four-step rail — ① Import estimate → ② Attach product data → ③ Review & fix →
④ Export — with per-step completion and one "next action" banner, driving the existing tabs.
File pickers alongside every drop zone; "Replace estimate workbook"; add/rename/delete scope.
Group validation into one verdict plus collapsed issue groups with jump-to-line, and demote
blank callout to a warning. Swap hardcoded hex for CSS variables. Disable inputs for viewers.
Add `data-testid`s, keyboard-activatable rows, input labels, and replace `window.confirm`.

### Phase 5 — Decisions for the owner (findings 25–26)
Route-level feature gate, and server-side persistence. Both need a product call first.

## Verification

`scripts/test-submittal-logic.ts` encodes the target behavior for the parser, pagination and
validation and is red today (14/29). Phases 1 and 3 should take it to green; Phases 2 and 4
need coverage added as the pure logic lands (page counts from real PDFs, derivation module).
