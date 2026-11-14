# AiPM Tool Belt — Human-in-the-Loop (HITL) Requirements

> **"The customer is always right in matters of taste."**
> — the original wording of the retail motto usually shortened to "the customer is always right"

That line is the guiding idea for this document. In AiPM, **the AI is allowed to be fast about facts, but it never gets the final say on judgment, preference, or taste.** Those belong to the human — the estimator, the PM, the customer.

---

## 1. What "Human-in-the-Loop" means here

**Human-in-the-loop (HITL)** means the AI does the heavy lifting (reading PDFs, pulling numbers, sorting pages), but a person **checks, corrects, and approves** before anything becomes "official" — before it lands in an estimate, a submittal, an RFQ email, or the Proposal Log.

Think of the AI as a very fast junior assistant: great at copying information off a page, not trusted to make calls that depend on experience, relationships, or what the customer wants.

---

## 2. The three kinds of decisions

Every piece of AI output in the app falls into one of three buckets. The bucket decides how much human involvement is required.

| Bucket | What it is | Examples | Who decides | Required HITL level |
|---|---|---|---|---|
| **A. Facts** | Information that is printed on the page and has one right answer | Quote number, quote date, unit price, quantity, spec section number (e.g. 10 28 00), page number | AI extracts, human **verifies** | **Review** — human can see and fix; low-confidence items must be checked |
| **B. Judgment** | Calls that need experience or context, where reasonable people could disagree | Is this page really a toilet-accessories page? Does this quote line match that schedule item? Is this a duplicate project? Which scope does this belong to? | AI **suggests**, human **decides** | **Approve** — nothing is committed until a human clicks approve |
| **C. Taste & Preference** | Choices driven by the customer's or estimator's preference, style, relationships, or business strategy | Which manufacturer to propose, Basis of Design, which vendors get an RFQ, markup / margin, wording of a proposal or email, cover page look, which alternates to offer | **Human only.** AI may offer options if asked, but never picks | **Own** — AI must not fill these in automatically or change them silently |

**Rule of thumb:** if two good estimators could look at the same thing and make different choices, and *both* would be fine, it's **Taste & Preference** — and the human is always right.

---

## 3. Requirements

Each requirement has an ID so it can be referenced in PRs, tickets, and the changelog.

### 3.1 Core rules (apply to every AI feature)

- **HITL-01 — No silent commits.** AI output must never be written into an estimate, submittal, Proposal Log entry, vendor database, or outgoing email without a human action (click, approve, send).
- **HITL-02 — Label AI output.** Anything the AI filled in must be visibly marked as AI-generated (badge, icon, or color) until a human confirms or edits it.
- **HITL-03 — Show confidence.** Every AI-extracted **Fact** must carry a confidence score shown to the user, using the shared thresholds:
  - High: ≥ 0.85
  - Medium: 0.65 – 0.84
  - Low: < 0.65 → **must** be reviewed before approval
- **HITL-04 — Show the source.** The user must be able to jump from an extracted value to where it came from (PDF page, region, or line of text) so they can check it in one click.
- **HITL-05 — Human edits win, forever.** Once a human edits or confirms a value, re-running the AI must **not** overwrite it. Re-extraction may only fill blanks or offer a "the AI now suggests X — accept?" prompt.
- **HITL-06 — Easy override.** Every AI-filled field must be editable inline. Rejecting an AI suggestion must take one click and never require a reason.
- **HITL-07 — Fail to manual, not to guessing.** If the AI fails or is unsure, the app must drop into a manual-entry / manual-review mode — never invent a value to fill a gap.
- **HITL-08 — Audit trail.** Record who approved, edited, or rejected each AI result, when, and what the AI originally said vs. what the human chose.

### 3.2 Taste & Preference rules (Bucket C)

- **HITL-10 — AI never chooses a preference.** The AI must not auto-select a manufacturer, Basis of Design, vendor list, markup, or alternates. These fields start empty (or with the *user's own* saved default) — never with an AI pick.
- **HITL-11 — Options, not answers.** If the AI offers help on a preference (e.g. "vendors who carry Bobrick"), it shows a list of options with reasons, and the human picks. No option is pre-checked because the AI likes it.
- **HITL-12 — Remember the human, not the model.** Saved defaults and favorites (preferred manufacturers per scope, preferred vendors per region, standard markups) come from what **users** chose before — not from AI ranking.
- **HITL-13 — Customer preference overrides spec "best match."** If a customer or GC states a preference (a specific manufacturer, finish, or vendor), that preference is recorded on the project and outranks any AI suggestion, even if the AI thinks another option fits the spec better. The AI may flag a possible conflict (e.g. "spec calls for X, customer prefers Y") but must not change the choice.
- **HITL-14 — Words that go out the door are human-approved.** Any text sent to a customer, GC, or vendor (RFQ emails, proposals, submittal cover pages) must be shown to the user in full and sent only by the user.

### 3.3 Judgment rules (Bucket B)

- **HITL-20 — Suggest with a reason.** Every AI judgment call (page classification, scope tag, schedule-to-quote match, duplicate warning) must show *why* — e.g. "flagged because keywords 'grab bar', 'toilet accessory' found on page."
- **HITL-21 — Bulk approve, single reject.** Users can approve many high-confidence suggestions at once, but must be able to reject or fix any single one.
- **HITL-22 — Unsure means ask.** Medium/low confidence judgments are shown as "needs your call," not pre-accepted.

### 3.4 Learning from corrections

- **HITL-30 — Capture corrections.** When a human corrects the AI, save the before/after pair so the team can see where the AI goes wrong most often.
- **HITL-31 — Corrections improve rules, with review.** Corrections may be used to improve dictionaries, prompts, or matching rules, but changes to shared rules must be approved by an admin — the AI does not retrain itself on one person's taste and push it onto everyone.

---

## 4. How this applies to each tool

| Tool | Facts (AI extracts, human verifies) | Judgment (AI suggests, human approves) | Taste & Preference (human only) |
|---|---|---|---|
| **Spec Extractor** | Section numbers, section titles, page ranges | Section label cleanup, suggested project name | Which sections to include in the package |
| **Plan Parser** | Page numbers, OCR text | Which scope each page belongs to | Which flagged pages to keep / export |
| **Quote Parser / Vendor Quote AI Extraction** | Vendor name, quote #, date, line items, unit costs, totals | Matching quote lines to schedule / estimate items | Which quote to carry, markup, which vendor wins |
| **Schedule Converter** | Schedule rows and columns from screenshots | Merging/splitting rows that look broken | Final schedule layout and naming |
| **RFQ Generator / Vendor Lookup** | Vendor contact info from the database | Which vendors are *eligible* (by scope / manufacturer tags) | **Which vendors actually get the RFQ, Basis of Design, approved manufacturers, email wording** |
| **Submittal Builder** | Product data pulled from files | Matching product data to schedule items | Cover page look, order, what gets submitted |
| **Project Start / Screenshot OCR / BC Sync** | Project name, address, dates, GC from screenshots or BuildingConnected | Duplicate-project warnings, region match | Approving the draft into a real project |
| **Chat assistant** | Answers based on project data | Recommendations | Anything decided from the chat is still made by the user in the actual tool |

---

## 5. Definition of Done for any new AI feature

Before an AI feature ships, the PR should be able to answer "yes" to each:

1. Is every AI output labeled as AI until a human confirms it? (HITL-02)
2. Do Facts show confidence and a link to their source? (HITL-03, HITL-04)
3. Is there a manual fallback if the AI fails? (HITL-07)
4. Can a human edit or reject every AI value, and do their edits survive a re-run? (HITL-05, HITL-06)
5. Is nothing committed or sent without a human click? (HITL-01, HITL-14)
6. Have all Taste & Preference fields been left for the human — no AI auto-picks? (HITL-10 to HITL-13)
7. Are approvals, edits, and rejections logged? (HITL-08)

---

## 6. Glossary (plain English)

- **AI extraction** — the AI reading a PDF or image and pulling information out of it.
- **Confidence score** — the AI's own guess (0 to 1) at how sure it is. 0.9 = very sure, 0.5 = coin flip.
- **Basis of Design (BOD)** — the specific product the architect designed around; other products may be "or equal."
- **Commit** (in this doc) — when information becomes official in the app (saved to the estimate, log, or sent out). Not the same as a git commit.
- **Audit trail** — a history of who did what and when.
