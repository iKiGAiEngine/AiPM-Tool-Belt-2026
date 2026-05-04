# Estimating Module — Demo Cheat Sheet
**Walk-through reference · May 2, 2026**
**Scope:** Inside an individual estimate at `/estimates/:id` — the 4-stage builder

---

## The 4-Stage Workflow

```
  Stage 1            Stage 2           Stage 3            Stage 4
  INTAKE     →     LINE ITEMS    →   CALCULATIONS    →    OUTPUT
(Project Info)    (The Builder)       (Markups)         (Proposal)
```

Every estimate runs through the same 4 tabs. Time is tracked at each stage.

---

## STAGE 1 — INTAKE (Project Info)

**Purpose:** Pull project metadata, set assumptions, lock the bid context.

| What to point out | What to say |
|---|---|
| Auto-populated project info | "Pulls from the Proposal Log — no re-keying project name, region, due date, GC contact" |
| Approved manufacturers list | "Spec Extractor results show up here — we already know which manufacturers the spec calls for" |
| Scope checklist | "Pick the Division 10 scopes that apply — this drives every category tab in Stage 2" |
| Assumptions / risks panel | "Free text for bid clarifications — saved with the version, never lost" |
| Stage time tracker | "The system tracks how long we spend in intake — currently averaging 6.5 min per bid" |

**Live numbers:** **39 minutes** of intake time tracked across 6 bids = avg **~6.5 min per bid**

---

## STAGE 2 — LINE ITEMS (The Builder)

**This is the workhorse. Spend the most time here.**

**Purpose:** Quantity takeoff, product selection, vendor pricing — all structured.

### 2A. Scope-Based Architecture (CSI Codes)

| What to point out | What to say |
|---|---|
| Category tabs by CSI code | "Each scope is its own tab — 10 28 00 Toilet Accessories, 10 21 00 Partitions, 10 26 00 Wall Protection, etc." |
| Tab roll-up totals | "Each tab totals independently and rolls into the grand total" |

### 2B. Product & Manufacturer Lookup

| What to point out | What to say |
|---|---|
| Manufacturer ComboBox | "Approved manufacturers from the spec show first — no guessing what's allowed" |
| Auto-product lookup | "Type a model number — the system finds it in our product database and auto-fills cost, description, manufacturer" |

### 2C. Vendor Quote Handling — **MAJOR ROI**

| What to point out | What to say |
|---|---|
| **AI Quote Parser** (PDF/image) | "Drop a vendor PDF here — AI reads the header, line items, prices, freight terms automatically" |
| **Paste-to-Parse** | "Paste raw text from an email — same AI categorization, no PDF needed" |
| Quote-to-line-item linking | "Link a parsed quote to a line item — locks the unit cost and shows 'Quote Backup ✓' on the line" |
| Lump Sum vs. Per-Item modes | "Handle both how vendors quote — we don't force them into our format" |
| Quote Backup status | "Every line shows whether it has vendor backup — instantly see what still needs a quote" |

**Live numbers:** **12 vendor quotes parsed** across estimates · saves ~20 min per quote

### 2D. Cost Breakouts (Building / Phase / Floor / Area)

| What to point out | What to say |
|---|---|
| Breakout Manager | "Define cost buckets — Building A vs Building B, Phase 1 vs Phase 2, Floor 3 vs Floor 4" |
| Allocation engine | "Split a single line item across multiple breakouts — quantity, dollars, or percentages" |
| Per-breakout markups | "Apply different OH/Fee/Escalation per breakout when needed" |

### 2E. RFQ Generator (Built Into the Estimate)

| What to point out | What to say |
|---|---|
| Consolidated RFQ button | "Pick a scope and the system pulls every approved manufacturer's vendor list automatically" |
| Auto-generated `.eml` file | "Generates an Outlook-ready email with project info, scope, and due date pre-filled" |
| RFQ Log tied to estimate | "Every RFQ is logged — we always know who we asked, when, and whether they responded" |
| Response tracking | "When a vendor quote comes back, link it to the original RFQ — closes the loop automatically" |

**Live numbers:** **33 RFQs sent** from inside estimates · 32 emailed via Outlook · saves ~15 min per RFQ

### 2F. Stage Time Tracking

**Live numbers:** **132 minutes** of line-item time tracked = the **single biggest time investment** in the workflow → which is exactly where the AI Quote Parser and product lookup save the most

---

## STAGE 3 — CALCULATIONS (Markups & Financial Engine)

**Purpose:** Apply OH, Fee, Escalation, Tax, Bond — globally or per-category.

| What to point out | What to say |
|---|---|
| Global markup controls | "Set escalation, OH, and fee at the estimate level — applies to everything" |
| Per-category overrides | "Need a different fee on accessories vs partitions? Override at the category level" |
| **Net-based fee math** | "Fees are calculated on the *final selling price*, not on cost — Selling = Cost ÷ (1 − Fee%) — no more 'I added 15% but the margin is only 13%'" |
| Tax engine | "Tax calculates on **material only** — freight and labor are excluded automatically per Washington/CA rules" |
| Bond rate | "Apply bond as a % of total — separate input, separate line on the proposal" |
| **Approval workflow for overrides** | "If someone overrides OH or Fee outside the standard range, it logs and requires executive sign-off" |

**Live numbers:** **6 minutes** of calculations time tracked = the math is fast because the engine handles it

---

## STAGE 4 — OUTPUT (Proposal)

**Purpose:** Generate the client-ready bid document.

| What to point out | What to say |
|---|---|
| **High-fidelity Proposal Letter** | "Print-ready HTML proposal with NBS branding, itemized scopes, terms — no Word, no copy-paste" |
| Optional unit pricing | "Toggle between lump sum and unit pricing without rebuilding the document" |
| **Excel export** | "Full estimate exports to `.xlsx` — for internal review or GC requests for backup" |
| **Two-way Proposal Log sync** | "Total, status, and selected scopes sync back to the Proposal Log automatically — no double entry" |

**Live numbers:** **16 minutes** of output stage time = the proposal is essentially generated, not authored

---

## Cross-Cutting Features (Mention as You Go)

### Version Control — **MAJOR ROI**

| What to point out | What to say |
|---|---|
| Version snapshot on save | "Every save creates a complete snapshot — items, quotes, markups, totals" |
| **Visual diffing** | "Compare any two versions side by side — 'Accessories went from $10K to $12K, +5 items, -1 item'" |
| **Session grouping** | "Rapid saves get grouped into work sessions — clean timeline instead of 200 entries" |
| Restore any version | "We can roll back to any point — never lose a number we showed a client" |

**Live numbers:** **70 versions saved** across 15 estimates · **avg 4.7 versions per estimate** · one estimate has **20 versions** showing active revision history

### Automated Checklist

| What to point out | What to say |
|---|---|
| Real-time completion status | "Auto-tracks: 'All items priced ✓', 'All backup attached ✓', 'Markups applied ✓' — no manual checklist" |
| Submission readiness | "We don't submit until the checklist is green" |

### Stage Activity Timer

| What to point out | What to say |
|---|---|
| Per-stage time tracking | "We know exactly how long each estimate takes — by stage. First time we've ever had this data" |

**Live distribution:** Intake 39 min · Line Items 132 min · Calculations 6 min · Output 16 min = **193 min total tracked**

---

## The Numbers to Have Ready

If your boss asks "what's the ROI on this module?":

| Claim | Number | Source |
|---|---|---|
| Estimates built in module | **15** | `estimates` table |
| Line items structured | **99** | `estimate_line_items` |
| Vendor quotes AI-parsed inside estimates | **12** | `estimate_quotes` |
| RFQs sent from inside estimates | **33** | `rfq_log` |
| Versions saved (audit trail) | **70** | `estimate_versions` |
| Largest estimate value | **$148,686** | `estimate_versions.grand_total` |
| Average estimate value | **$40,115** | `estimate_versions.grand_total` |
| Active estimating time tracked | **193 min** | `estimate_activity_events` |
| Modeled time savings (this module's features) | **~$1,000+** | Quote Parser + RFQ + Versioning combined |

---

## One-Sentence Summary Per Feature

- **AI Quote Parser:** "Vendor PDF in, structured line items out — no copy-paste."
- **Approved Manufacturer ComboBox:** "Spec compliance is enforced at the dropdown level."
- **Cost Breakouts:** "Allocate any line item across buildings, phases, or floors without rebuilding the estimate."
- **RFQ Generator:** "Vendor outreach goes from 20 minutes to 30 seconds and stays tied to the estimate."
- **Net-Based Fee Math:** "Fees calculated on selling price — the margin you set is the margin you get."
- **Tax Engine:** "Material only, freight and labor excluded — no manual tax math."
- **Version Control + Diffing:** "Every save is a snapshot. We can show exactly what changed between any two versions."
- **Approval Workflow:** "Overrides outside the standard range require executive sign-off — built into the workflow, not a separate process."
- **Two-Way Proposal Log Sync:** "Total, status, and scopes sync back automatically — zero double entry."
- **Stage Timer:** "First time we've ever measured how long an estimate actually takes."

---

*Live data as of May 2, 2026 · All numbers from production database · AiPM Tool Belt · NBS Internal*
