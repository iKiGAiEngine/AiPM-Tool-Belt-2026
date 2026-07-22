# SOP: Adding a New Project to the Proposal Log

## Purpose

This is the step-by-step guide for getting a new bid into the Proposal Log — from the moment an invitation shows up to the moment the entry is accurate, complete, and ready for the team to work from. No coding knowledge required. If you know how a bid normally comes in (BuildingConnected invite, an email from a GC, a phone call), you already know everything you need to follow this.

The Proposal Log is the single source of truth for every active and past bid. If a project isn't in the Log, it doesn't exist as far as reporting, pipeline, and the rest of the team are concerned — so getting it in there correctly, every time, matters.

---

## The Two Ways a Bid Gets In

Every new bid comes in one of two ways. Pick the right one — don't do both, or you'll create a duplicate.

| If the bid came from... | Use this path |
|---|---|
| BuildingConnected (BC) invite | **Path A: BC Sync** |
| Email, phone call, walk-in, internal project, or anything not in BuildingConnected | **Path B: Project Start** |

> **Rule of thumb:** Always check BC Sync first. If the invite is already sitting in BuildingConnected, syncing it in takes less typing and pulls in more accurate data automatically (GC name, due date, address, square footage) than typing it by hand.

---

## Path A: BuildingConnected (BC) Sync

Use this when the bid invitation came through BuildingConnected.

### Step 1: Open the Proposal Log

From the Home page, click the **Proposal Log Dashboard** tile. The sync controls are at the top of the page (admin-only — if you're not an admin, ask one to run this step).

### Step 2: Click Sync

The button shows a spinner while it runs. Most syncs finish in 5–15 seconds. When it's done, a toast message tells you how many new drafts were created.

### Step 3: Open the Drafts queue

If new drafts came in, a banner appears at the top of the Proposal Log with a **Review Drafts** button. Click it.

### Step 4: Review each draft

Click a row in the Drafts queue to open the Review Draft window. It shows everything BuildingConnected pulled in automatically:

- Project Name
- GC (general contractor)
- Due Date
- Project Address
- Anticipated Start / Finish dates
- Square Footage
- The BC link (so anyone can jump back to the opportunity)

**Check these against the actual invite** — auto-filled data is usually right, but always give it a quick look before approving.

### Step 5: Fill in what BC doesn't know

BuildingConnected can't tell us things like which region or estimator should own the bid. Fill in:

- **Region** — the branch this bid belongs to (e.g., LAX, PDX, SEA, DEN, DFW, CLT, ATL, AUS, GEG, CLT, SFO)
- **Primary Market** — project type (Education, Healthcare, Aviation, Hospitality, Residential, Retail, Office, Entertainment, Parking Structure, Public Facility, Special Projects)
- **Scope checklist** — which of our scopes apply (Toilet Accessories, Toilet Partitions, Lockers, Wall Protection, FRP, etc.)
- **NBS Estimator** — who will own this bid

> **Before you approve:** Visually verify the five fields listed in [Mandatory Verification](#mandatory-verification--before-you-finalize) below against the actual BC invite. Don't rely on the auto-fill alone.

### Step 6: Approve and create the project

Click **Approve & Create Project**. This one click:

- Creates a real, live Proposal Log entry
- Generates the next estimate number
- Creates the project folder structure on the server
- Stamps the estimate Excel template with the project info

The draft disappears from the queue, and the new row shows up in the live Proposal Log. **You're done — the project is now fully set up.**

### OR — Reject the draft

If the invite is junk (wrong scope, a GC we don't bid for, a duplicate), click **Reject**. It's removed and won't reappear on the next sync.

### Common issues

| Problem | Fix |
|---|---|
| Synced but nothing showed up | BC only returns *new* opportunities it hasn't seen before. If you've already synced recently, there may be nothing new yet. |
| A draft has the wrong project name | Edit it right in the Review Draft window before approving. You can also rename it inline in the Proposal Log after approval. |
| Don't see the Sync button | Sync is admin-only. If you are an admin and still don't see it, hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R). |

---

## Path B: Project Start (Manual Entry)

Use this for anything **not** from BuildingConnected — an emailed invite, a phone call, a walk-in job, or an internal project.

### Step 1: Open Project Start

From the Home page, click the **Project Start** tile.

### Step 2 (Optional Shortcut): Screenshot OCR

If you have a screenshot of the bid invite (an email screenshot, a listing on Procore, etc.), drag it into the **Quick Fill from Screenshot** area at the top of the form, or paste it directly (Ctrl+V / Cmd+V). The tool reads the image and auto-fills:

- Project Name
- Due Date
- Region (guessed from the client's office location)
- Invite Date, Anticipated Start/Finish
- Primary Market (best guess)
- GC contact name and email (shown for reference)

Review every auto-filled field before moving on — OCR works best on clean, high-resolution screenshots, but it's not perfect. Type over anything wrong.

You can skip this step entirely and type everything in by hand.

### Step 3: Fill in the three required fields

These must be filled in before you can create anything:

- **Project Name** — e.g., "DEN Legacy Concourse Restroom Renewal"
- **Region** — pick from the dropdown
- **Due Date** — the bid submission deadline

> **Year Check:** If you pick a date in November or December while the current month is also November or December, the tool asks you to confirm this year vs. next year — this catches accidental typos that would misdate the bid.

### Step 4: Fill in Proposal Log Details (recommended, not required)

These fields flow directly into the Proposal Log entry, so filling them in now saves a second trip later:

- **Primary Market** — project type
- **Estimate Status** — defaults to "Estimating"
- **Invite Date** — when the invitation was received
- **Est. Start / Est. End** — anticipated construction dates

### Step 5: Upload documents (optional)

- **Plans PDF** — drop it in to trigger automatic page classification by scope
- **Specs PDF** — drop it in to trigger automatic Division 10 section extraction

You can upload both, one, or neither. With neither, you still get a complete "Folder Only" project — folder structure, stamped estimate, and Proposal Log entry.

> **Before you click Create:** Visually verify the five fields listed in [Mandatory Verification](#mandatory-verification--before-you-finalize) below — this matters even more here than in BC Sync, since more of this data was typed or OCR'd by hand.

### Step 6: Click Create Project

Once the three required fields are filled in, the button becomes active. Click it and let it run — you'll see a progress overlay. You don't have to stay on the page; a status indicator in the header shows progress if you navigate away.

### What you get when it's done

- **A Proposal Log entry** — live in the dashboard with the next estimate number
- **An organized project folder** on the server with the standard subfolders
- **A stamped Excel estimate** — pre-filled with Project ID, Name, Region, and Due Date
- **Extracted spec sections** (if you uploaded specs)
- **Classified plan pages by scope** (if you uploaded plans)

The project is now in the Proposal Log. Any field can be edited there afterward.

---

## Mandatory Verification — Before You Finalize

Auto-fill (BC Sync) and OCR (Screenshot fill) both guess. They're usually right, but "usually" isn't good enough on data that drives assignments, scheduling, and where the bid gets mailed or delivered. **Before you approve a draft or click Create Project, the estimator must visually check these five fields against the actual source document (the BC listing, the invite email, the plans/specs cover sheet) and correct anything wrong:**

1. **Project Name** — matches what the GC/owner actually calls it
2. **Region** — the correct branch, not just a plausible guess
3. **Due Date** — the real bid submission deadline, including the year
4. **SP (Self-Perform) Estimator** — the right person is assigned, not a leftover default
5. **Project Address** — correct and complete, since this drives shipping, site visits, and reporting

This check takes under a minute and happens **every time**, regardless of which path you used to get the bid in. Don't skip it just because a field auto-filled — auto-filled and OCR'd values are guesses, not verified facts, until a human confirms them.

---

## Making Sure the Data Is Accurate

Getting the row created is only half the job — the data in it has to be correct and complete, because this is what drives reporting, assignments, and the pipeline view every estimator and manager relies on.

### Anatomy of a Row — What Each Field Means

| Field | What It's For | Notes |
|---|---|---|
| **Project Name + Due Date** | Identifies the bid. Due Date shows business days remaining (e.g., "3BD" = due in 3 business days, "Overdue" = past due). | Keep the name matching what the GC calls it — makes searching easier. |
| **Status** | Drives the lifecycle: New → Estimating → Submitted → Won / Lost / No-Bid. | Click the status pill to change it. Every change is logged (who, when). |
| **Estimator (NBS Estimator)** | Who owns the bid. | Click to assign/change. Only admins can reassign a bid someone's already started working. |
| **SP (Self-Perform) Estimator** | Who owns the self-perform portion of the bid, where applicable. | Region-specific list. Visually verify this is the right person — it's easy to leave a stale default in place. |
| **Region & Primary Market** | Drives regional and market reporting/pipeline views. | Click to edit inline. **Never leave these blank.** |
| **Project Address** | The physical job site location. | Drives shipping, site visits, and reporting. Verify it's complete and correct, not just auto-filled. |
| **Notes / Comments** | Free-form notes on anything else worth flagging. | Shows as a tooltip on hover. Not a substitute for a real field (see Common Mistakes below). |
| **Bid Source Link** | Small icon next to the project name — jumps to the BC opportunity, source email, or attachment. | Lets anyone trace back to the original invite. |
| **Proposal Total** | The dollar amount submitted. | Has its own dedicated field — always use it, never bury it in Notes. |
| **Scope Checklist** | Which trade scopes this bid covers (Toilet Accessories, Partitions, Lockers, etc.). | Multi-select — check every scope that applies. |

### Editing Rules

- Most fields — status, estimator, region, market, dates, notes, scope checklist — edit inline by clicking. Changes save automatically; there's no separate "save" step.
- If you fix something on someone else's row (a typo, a wrong date), go ahead — just leave a note in the comments so they know it changed.
- Status changes are tracked with who made the change and when. Admins can pull this history if there's ever a question.

### Status Lifecycle — Keep It Moving

| Status | Meaning |
|---|---|
| **New** | Just landed, no estimator working it yet. Should move to Estimating within a day or two. |
| **Estimating** | Actively being worked. Should have an estimator and a due date set. |
| **Submitted** | Proposal sent to the GC. Move it here the moment you hit send, and fill in the Proposal Total. |
| **Won** | We're doing the project. |
| **Lost** | GC awarded to someone else. |
| **No-Bid** | We chose not to submit (wrong scope, no time, etc.). |

> **Always land on a final state.** Don't leave bids sitting in "Submitted" indefinitely — a clean Proposal Log is a useful Proposal Log.

---

## Common Mistakes to Avoid

1. **Creating a duplicate.** Always check BC Sync first for BuildingConnected invites — don't manually create a project that's already sitting in the Drafts queue.
2. **Leaving Region or Market blank.** These drive every regional and market report. A bid with no region/market disappears from pipeline views.
3. **Putting the Proposal Total in the Notes field.** There's a dedicated field for it — Notes doesn't roll up into any report.
4. **Leaving a bid on "New" for weeks.** If someone's working it, mark it Estimating. If not, close it out as No-Bid.
5. **Skipping the review step on auto-filled data.** Both BC Sync and Screenshot OCR are usually right, but always double-check before approving/creating — a wrong due date or GC name is much harder to catch later.

---

## Quick Reference Checklist

Use this every time you add a new project:

- [ ] Checked BuildingConnected first — is this bid already a draft waiting to be reviewed?
- [ ] If yes → reviewed the draft, filled in Region/Market/Scope/Estimator, approved it
- [ ] If no → opened Project Start, filled in Project Name / Region / Due Date, optionally used Screenshot OCR
- [ ] Uploaded plans and/or specs if available
- [ ] Visually verified Project Name, Region, Due Date, SP Estimator, and Project Address against the source document — **before** clicking Approve or Create Project
- [ ] Clicked Create Project (or Approve, for BC drafts) and confirmed the row appeared in the Proposal Log
- [ ] Region and Primary Market are filled in — not blank
- [ ] Estimator is assigned
- [ ] Status matches reality (don't leave it on "New" if work has started)
- [ ] Notes contain context, not data that belongs in a dedicated field (Proposal Total, dates, etc.)
