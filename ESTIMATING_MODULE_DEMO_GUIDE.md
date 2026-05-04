# Estimating Module — Demo Cheat Sheet
**Walk-through reference · May 2, 2026**

---

## The Workflow (in order)

```
Proposal Log → Project Start → Spec Extractor → Estimate Builder → Quote Parser → RFQ → Output
```

---

## 1. Proposal Log — Where It All Starts

**Point out:** Every bid flows through a single system of record instead of a spreadsheet or email chain.

| What to show | What to say |
|---|---|
| Active bid list | "Every open opportunity — 22 live bids across 14 regions — tracked in one place" |
| Status column | "Estimating → Submitted → Won/Lost — we can see the full pipeline at a glance" |
| BuildingConnected sync badge | "When a GC invites us on BuildingConnected, it auto-creates the entry here — no manual data entry" |
| Region / estimator assignment | "We assign bids by region and estimator — Gonzalo or Gene gets pinged, they own it from here" |

**Live numbers:** 30 proposals tracked · 13 auto-synced from BuildingConnected · 14 regions covered

---

## 2. Project Start — AI Kicks Off the Bid

**Point out:** One click starts the entire bid workflow — no setup, no folder hunting.

| What to show | What to say |
|---|---|
| "Start Project" button | "This auto-generates the project ID, sets up the folder structure, and queues the spec + plan extraction" |
| Auto-generated estimate number | "Estimate numbers follow our NBS format automatically — no manual numbering" |
| Spec + Plan auto-queued | "The moment a project starts, the AI begins reading the spec book in the background" |

**Live numbers:** 17 project starts logged (Gonzalo + Gene alone) · saves ~15 min of setup per bid

---

## 3. Spec Extractor — AI Reads the Spec Book

**This is the biggest ROI feature in the module. Spend time here.**

**Point out:** The AI reads the entire project manual and pulls every Division 10 section — automatically.

| What to show | What to say |
|---|---|
| Upload spec PDF | "Drop in the project manual — we've processed spec books up to 2,491 pages" |
| Auto-identified sections | "The AI finds every Div 10 section: Toilet Accessories, Partitions, Wall Protection, Signage, FEC, Lockers" |
| Section # + page range | "We get the exact section number, title, and page range — ready to pull specs without digging" |
| AI review notes | "It flags ambiguous or non-standard sections for human review" |

**Live numbers:**
- **49 completed sessions** · **52,447 total spec pages processed by AI**
- **334 Division 10 sections extracted** — avg 7.3 per project
- **Saves ~30 min per bid** vs. manual spec review = **$37.50/bid at $75/hr**
- Gene processed 4,478 pages across 4 projects on his **first day** using the tool

---

## 4. Estimate Builder — Line Items + Versioning

**Point out:** Structured estimating with full version history — no more "estimate_v7_FINAL_use_this_one.xlsx."

| What to show | What to say |
|---|---|
| Line item entry | "Each scope gets its own line items — material, labor, markup, all structured" |
| Version snapshot | "Every time we save a revision, the system creates a version — we have 70 saved versions across 15 estimates" |
| Version history panel | "We can go back to any point in time and see exactly what the number was and why it changed" |
| Grand total auto-calc | "Totals roll up automatically — no formula errors" |
| Stage timer | "The system tracks active time in each stage — we know exactly how long estimating actually takes" |

**Live numbers:**
- **15 estimates** · **99 line items** · **70 saved versions**
- Avg **4.7 versions per estimate** · one estimate has **20 versions** (shows active revision history)
- Max estimate value on record: **$148,686** · avg: **$40,115**
- **193 minutes of active estimating time** tracked across 6 bids

---

## 5. Quote Parser — AI Reads Vendor Quotes

**Point out:** Vendor PDFs go in, structured line items come out — no copy-paste.

| What to show | What to say |
|---|---|
| Upload vendor quote PDF | "Drop in a vendor's quote — the AI reads it and extracts item, quantity, and price" |
| Parsed line items | "It maps their line items to our estimate structure automatically" |
| Compare quotes side by side | "We can stack multiple vendor quotes and see who's competitive on each scope" |

**Live numbers:** **12 vendor quotes parsed** · saves ~20 min per quote · **$25/quote at $75/hr**

---

## 6. RFQ Generator — Vendor Outreach in Seconds

**Point out:** Goes from estimate to vendor email without touching Outlook or a quote template.

| What to show | What to say |
|---|---|
| Select scope + manufacturers | "Pick the scope — Toilet Accessories, Wall Protection, etc. — and the system pulls the right vendor list" |
| Auto-generated RFQ email | "It writes the RFQ with project info, scope details, and due date pre-filled" |
| Send from inside the platform | "One click sends to the vendor — logged automatically, no tracking spreadsheet needed" |
| RFQ log | "Every RFQ is timestamped and tied to the estimate — full vendor outreach history" |

**Live numbers:** **33 RFQs sent** · 32 via email · saves ~15 min per RFQ · **$18.75/RFQ**

---

## 7. Estimate Output — Proposal Ready

**Point out:** The estimate produces a client-ready proposal document directly from the structured data.

| What to show | What to say |
|---|---|
| Proposal preview | "The output pulls from the estimate — no reformatting, no copy-paste into Word" |
| Scope breakdowns | "Each Division 10 scope listed separately with pricing" |
| Revision timestamp | "Every proposal is tied to a version — we always know which number we submitted" |

---

## The Numbers to Have Ready

If your boss asks "what's the ROI?" — use these:

| Claim | Number | Source |
|---|---|---|
| Spec pages reviewed by AI | **52,447 pages** | Live DB — `spec_extractor_sessions` |
| Div 10 sections extracted | **334 sections** | Live DB — `spec_extractor_sections` |
| RFQs generated | **33 RFQs** | Live DB — `rfq_log` |
| Vendor quotes parsed | **12 quotes** | Live DB — `estimate_quotes` |
| Estimate versions saved | **70 versions** | Live DB — `estimate_versions` |
| Largest estimate on record | **$148,686** | Live DB — `estimate_versions` |
| Gonzalo + Gene savings (to date) | **$1,031** | Modeled from actual usage |
| Annualized (2 users, current pace) | **~$5,200/yr** | Extrapolated from 10.5 weeks |

---

## One-Sentence Summary Per Feature

- **Spec Extractor:** "The AI reads the entire spec book so the estimator doesn't have to."
- **Quote Parser:** "Vendor PDFs become structured line items without any copy-paste."
- **RFQ Generator:** "Vendor outreach goes from 20 minutes to 30 seconds."
- **Version Control:** "Every revision is saved — we always know what we submitted and when."
- **BC Sync:** "BuildingConnected invites auto-create the bid entry — zero manual logging."
- **Stage Timer:** "We now know exactly how long estimating takes — and can prove it."

---

*Live data as of May 2, 2026 · All numbers from production database · AiPM Tool Belt · NBS Internal*
