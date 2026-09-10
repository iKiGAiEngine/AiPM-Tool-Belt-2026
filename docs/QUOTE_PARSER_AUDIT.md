# Quote Parser — Deep-Dive Audit & Overhaul

**Date:** July 2026
**Scope:** `server/quoteparser/*`, `server/pdfUtils.ts`, `client/src/pages/QuoteParserPage.tsx`, Quote Parser tab in Central Settings
**Outcome:** The tool went from a one-shot "AI reads the quote" parser to a three-gate quote **quality-control system** with a learning loop and background data collection.

The operating promise after this overhaul: **every number is either proven or flagged.** A parse ends in one of two verdicts — ✅ VERIFIED (math balances, requirements matched, every line high-confidence) or ⚠️ NEEDS REVIEW with an itemized list of exactly what to look at and why. The tool never silently hands over an unverified number.

---

## Part 1 — Audit findings (what was wrong)

### Broken or accuracy-critical

| # | Finding | Impact |
|---|---------|--------|
| 1 | **Scanned-PDF path broken in production.** OCR required the `pdftoppm` binary (poppler), which is not in `replit.nix`; the sharp-based fallback cannot rasterize PDFs (libvips has no PDF loader). Scanned quotes hard-failed with "Could not extract text." | Scanned/photographed quotes unusable |
| 2 | **iPhone photos (HEIC) crashed the parse.** `routes.ts` sent `data:image/heic` straight to the OpenAI vision API, which rejects HEIC. The old pre-AI path converted via sharp; the AI path lost that step. | HEIC uploads always failed |
| 3 | **No per-line prices extracted → no self-verification.** The AI was never asked for unit/extended prices; every output row hardcoded `material: "$0.00"`. There was no way to check the parse arithmetically. | Misread totals went undetected |
| 4 | **Tax ignored in the total fallback.** Prompt said grand total − freight = material; real grand totals include tax, so material came out high on taxed quotes. | Inflated material totals |
| 5 | **PDF text scrambled before the AI saw it.** `pdfUtils.ts` joined every text item on a page with a single space — an entire page collapsed into one run-on line, destroying row/column structure. | Qty/model/price column mix-ups |
| 6 | **AI output format not enforced.** JSON was requested via prompt and recovered with regex fence-stripping; a malformed reply meant a generic 500 with no retry. | Random hard failures |
| 7 | **Inputs didn't combine.** Providing a screenshot AND pasted text silently discarded the text. Spec input was PDF/text only (no images). No schedule input existed at all. | Lost information, no coverage check |
| 8 | **PLAN CALLOUT column always empty.** A schedule-matching module (`scheduleParser.ts`, 253 lines) was written long ago and never wired to anything. | No quote-vs-plan verification |

### No memory, no learning

| # | Finding | Impact |
|---|---------|--------|
| 9 | **Every parse vanished.** Nothing was logged — no way to measure accuracy, analyze trends, or build a regression set. | Accuracy unmeasurable |
| 10 | **Feedback lossy.** "Something's wrong" saved the note but the `rawTextSnippet` column was never populated (the client never sent it) — complaints arrived without evidence. "Looks correct" did nothing but show a toast. | Feedback couldn't drive fixes; no positive signal |
| 11 | **Vendor lessons never applied.** The system prompt had a "VENDOR-SPECIFIC RULES" placeholder that stayed empty forever; `VendorParseConfig` in the schema was referenced only by dead code. Vendor "memory" was an N+1 hack over `systemSettings` JSON keys. | Same mistakes repeated per vendor |

### Hygiene & safety

| # | Finding | Impact |
|---|---------|--------|
| 12 | **~560 lines of dead code**: the entire pre-AI regex parser (`parseQuoteText` + helpers in `quoteParser.ts`) and all of `scheduleParser.ts`. | Confusion, maintenance drag |
| 13 | **Master prompt editable by any logged-in user.** `PUT /system-prompt` and `PATCH /feedback/:id` were `requireAuth` only; the settings UI hid the button from non-admins but the API had no lock (a prompt-injection surface). | Security gap |
| 14 | **No input-size guardrails**; a huge upload could blow the model's context window. Long quotes could silently truncate output JSON (no `finish_reason` check). | Jammed or partial parses |
| 15 | `new OpenAI()` at module load would crash the whole server on import if the API key were absent — despite the route having a graceful CONFIG_ERROR path. | Latent boot crash |

---

## Part 2 — What was built

### Gate 1 — Math (deterministic self-check) · `server/quoteparser/reconcile.ts`
- The AI now extracts `unitPrice`, `extendedPrice` per line and `taxTotal` — under a **CORE OUTPUT CONTRACT** appended server-side to whatever handbook is stored: *never guess a price; use null and lower confidence when unreadable.*
- `reconcileTotals()` re-does the estimator's arithmetic: qty × unit vs. each line's extension (mismatch → that line's confidence is capped at 70 and named in the review list), and Σ(lines) vs. material total (±$0.02). Partial price coverage can never fully pass.
- Prices are **display + verification only**: the TSV/CSV export format is byte-identical to before ($0.00 per line, totals on the summary row) so the estimate-sheet paste workflow is untouched.

### Gate 2 — Spec compliance (upgraded)
- Spec input now accepts PDF, image, or text — combined. Scanned spec PDFs are read visually.
- The reviewer prompt is instructed to never claim compliance it can't see evidence for ("warn" + what to verify).

### Gate 3 — Schedule coverage (new) · `server/quoteparser/scheduleMatcher.ts`
- New Plan Schedule input (PDF/image/text). The AI extracts entries (callout, description, model, qty) under a strict schema; **pairing is deterministic code**, not AI: normalized model match > description similarity (Levenshtein) > qty corroboration, greedy one-to-one assignment.
- Fills the PLAN CALLOUT column (its original purpose, finally), and flags: schedule items missing from the quote, quantity mismatches, and quoted items not on the schedule.

### Verdict
- One banner combines all gates: **VERIFIED** or **NEEDS REVIEW: n items**, with green confirmations and an itemized flag list (bad line math, low-confidence lines with reasons, spec fails/warns, coverage gaps). Any line under 95% confidence is listed.

### Reading pipeline fixes
- **Scanned PDFs:** pages render to PNG via `pdfjs-dist` + the already-installed `canvas` package (`pdfToImages.ts`) and go to the vision model. Tesseract/poppler dependency removed entirely.
- **Text PDFs:** `pdfUtils.ts` now reconstructs real lines from glyph coordinates (grouped by y, sorted by x, wide gaps become column separators). Shared util — the estimating and buyout modules that use it also benefit.
- **HEIC/unknown image formats** are converted to PNG via sharp before any vision call.
- **All quote sources combine**: file + pasted screenshot + pasted text go to the model as one request, labeled per source.
- **Strict Structured Outputs** (`response_format: json_schema, strict: true`) with Zod validation, one automatic repair retry (the validation error is fed back), a fallback for models without strict mode, and a `finish_reason` truncation warning. Model configurable via `OPENAI_QUOTE_MODEL` (default `gpt-4o`).

### Learning loop & background data · `server/quoteparser/runLog.ts`
- **`quote_parser_runs`** — every parse logged: vendor, quote #, input types, model, duration, bounded text snippet (4k cap), full result JSON, per-gate results, verdict, reconciliation status, feedback. Vendor memory and the accuracy scorecard are derived from it (the old systemSettings counter hack is gone).
- **`vendor_price_history`** — one row per priced product line: vendor, model, description, unit/extended price, qty, quote #, date. Quiet background collection for later analysis (price trends per model, vendor comparisons, freight creep).
- **Feedback that teaches:** 👍 and 👎 are both recorded against the run; complaints automatically carry the quote text. In settings, **"Draft Rule with AI"** turns a complaint + its evidence into a suggested vendor rule; an admin approves it and it's injected into the system prompt on every future parse of that vendor. Rules are curated, editable, and size-capped (4,000 chars) so the prompt can never bloat — built to improve with age, not rot.
- **Accuracy scorecard** in settings: parses, fully-verified rate, math-pass rate, 👍/👎 counts, price records collected.

### Hardening & cleanup
- `requireAdmin` on `PUT /system-prompt`, `PATCH /feedback/:id`, `PUT /vendor-rules/:id`, `POST /feedback/:id/draft-rule`.
- Text caps: 60k chars (quote) / 40k (spec) / 40k (schedule), with friendly warnings; feedback fields length-capped; status values validated.
- Dead code removed: `scheduleParser.ts` deleted; `quoteParser.ts` reduced from 506 lines to a small extraction module; OpenAI client made lazy (no boot crash without a key).

### UI (`QuoteParserPage.tsx`)
- Verdict banner, schedule input card, schedule coverage report card, unit/ext price columns (shown only when prices exist), tax note.
- **Click-to-edit cells** for callout, description, model, and qty — corrections flow into copy/download without re-parsing.
- A badge shows when multiple quote sources will be combined; 👍 wires to the run log; 👎 notes that the quote text is attached automatically.

### Tests · `scripts/quoteparser-test.ts`
32 assertions over the deterministic pipeline (no DB, no API): reconciliation pass/mismatch/no-price/partial cases, confidence downgrades, tag/decal consolidation, schedule matching (match/missing/qty-mismatch/extra), PDF line grouping, real PDF → text and → PNG rendering, and schema validation. Run: `npx tsx scripts/quoteparser-test.ts`.

---

## Part 3 — Deployment notes

1. **Database migration required:** `npm run db:push` (adds `quote_parser_runs`, `vendor_price_history`, and `quote_parser_feedback.run_id`).
2. Optional: set `OPENAI_QUOTE_MODEL` to override the default `gpt-4o`.
3. No export-format changes: anything downstream of the TSV/CSV is unaffected.
4. The stored AI Handbook (if one was saved in the DB) keeps working — the pricing/honesty contract is appended server-side and cannot be edited away.
