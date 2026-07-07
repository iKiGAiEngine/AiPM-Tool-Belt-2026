# Email Intake — BC & GC bid-invite drag-and-drop

Turns a dropped bid-invite email (`.eml` / `.msg`) into a **draft** proposal-log
entry that flows through the existing draft-review process, enriching it from the
BuildingConnected API when the invite links to an opportunity.

## Pipeline (`intakeService.ts` → `processEmailIntake`)

1. **Idempotency** — sha256 of the file bytes; a re-drop returns `duplicate_intake`.
2. **Ledger first** — an `email_intake_log` row is written with `status:"processing"`
   *before* parsing, so a crash still leaves a visible record. Every dropped email
   ends in exactly one of `draft_created` | `duplicate_intake` | `failed`.
3. **Parse** (`emailParser.ts`) — `.eml` via `mailparser`, `.msg` via `@kenjiuno/msgreader`
   (+ compressed-RTF fallback). File type is sniffed by magic bytes, not mimetype.
4. **Extract** (`fieldExtractor.ts`) — 3 tiers, never throws:
   `LLM (gpt-4o-mini)` → `labeled/regex` → `floor (subject/sender/date)`.
5. **BC reference pull** (`bcLinkResolver.ts` + `bcReferencePull.ts`) — unwrap the
   invite link (login `continueUrl`, trackers), then GET-by-id on the Bid Board and
   GC APIs with a list-fetch fallback, using the dropper's own APS token.
6. **Merge with provenance** — BC values override email values per field; `provenance`
   records `email` | `bc` | `fallback` per field. Only the fields the log already
   displays are written; the full BC payload is stored in `bc_raw_data`.
7. **Draft + dedupe** — insert `isDraft` entry (`sourceType` `email`/`bc-email`),
   guard against an already-synced opportunity, run `findFuzzyDuplicates` and stamp
   the `__dup:` marker so the reviewer can merge it as a **bid round**.
8. **Audit** — `auditLog` + `recordEntryCreation` + admin notification on every draft.

## Tests

```
tsx server/emailIntake/emailParser.test.ts
tsx server/emailIntake/bcLinkResolver.test.ts
DATABASE_URL=... tsx server/emailIntake/fieldMerge.test.ts
```

Binary `.msg` fixtures are generated (checked in), regenerate with:
`tsx server/emailIntake/fixtures/generateMsgFixtures.ts`.

## End-to-end audit

`scripts/email-intake-audit.ts` runs every fixture through the full pipeline against
a real Postgres, stubs the BC API from recorded payloads, blocks all other network,
and diffs **every** entry field + provenance against `fixtures/expected/*.json`. It
asserts the "no missed bids" invariants (ledger row exists, no `processing` leftovers,
re-drop → `duplicate_intake`, re-bid → fuzzy-dup round candidates) and cleans up after
itself.

```
DATABASE_URL=... tsx scripts/email-intake-audit.ts        # regex/floor tiers
DATABASE_URL=... OPENAI_API_KEY=... tsx scripts/email-intake-audit.ts   # LLM tier
```

**Known limitation:** without `OPENAI_API_KEY` the audit verifies the deterministic
`regex`/`floor` tiers. The `LLM` tier's expected values live in each fixture's
`entryLlm` block but have not been exercised against a live model in CI — run the
audit with a key set to validate them.
