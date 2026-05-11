# Estimating Module — Disclaimer & Boilerplate Text Review

**Purpose:** All standing/auto-generated language that goes out the door from the Estimating Module — for boss review, edits, and additions.

**Source files:** `client/src/pages/EstimatingModulePage.tsx`, `server/estimateRoutes.ts`

Each block below shows **(a)** what is hardcoded today, **(b)** where it appears, and **(c)** any blanks the estimator fills in per project.

---

## 1. PROPOSAL (Customer-Facing PDF Preview)

This is the formal proposal that goes to the GC. Sections appear in this order on the printed/exported PDF.

### 1A. Section "02 — Qualifications"
*Only renders if at least one item exists in this section.*

- **Assumptions list** — populated by the estimator (free-text bullets). No hardcoded defaults.
- **Per-Scope Qualifications** — populated by the estimator under each scope (e.g. Toilet Accessories, Lockers). Blank by default.
- **Notes & Risks** — populated by estimator. **One auto-default risk** is inserted on every new estimate:
  > ⚠ *Lead times may extend beyond anticipated start date — verify with vendors*

### 1B. Section "03 — Inclusions" *(hardcoded — always appears)*
- • Addenda acknowledged: *(only shows if estimator entered addenda numbers)*
- • **Furnish all Division 10 materials per plans and specifications**
- • **Sales tax included (X%)** *— OR —* **Sales tax NOT included** *(toggles based on the tax rate set on the estimate)*
- • **Freight to jobsite included**
- • Per-Scope Inclusions added by estimator (blank by default)

### 1C. Section "04 — Exclusions" *(hardcoded — always appears)*
- • **Installation labor by others**
- • **Blocking, backing, and rough-in by others**
- • **Offloading, distribution, and handling by others**
- • **Items not specifically listed above**
- • **Any work beyond furnishing of materials**
- • Per-Scope Exclusions added by estimator (blank by default)

### 1D. Validity Block *(hardcoded — always appears)*
> **VALIDITY**
> *This proposal is valid for 30 days from the date above.*

### 1E. Signature Block
- "Best Regards,"
- *{Estimator name from their AiPM profile}*
- **NATIONAL BUILDING SPECIALTIES · FURNISH ONLY**
- If no signature on file: a dashed-gold box reading **"[ NO SIGNATURE ON FILE ]"**

---

## 2. PROPOSAL LETTER (Plain-Text Alternate Format)

Used when copying the proposal as text instead of the formatted PDF preview.

```
NATIONAL BUILDING SPECIALTIES

Date: {today}
Re: {Project Name}
PV#: {Estimate Number}

National Building Specialties is pleased to submit the following proposal
for FURNISHING Division 10 Specialties:

{scope-by-scope item list and totals}

TOTAL BID (Furnish Only — Material Only): ${grand total}

Assumptions:
{estimator's assumption bullets}

Inclusions:
• Furnish all Division 10 materials per plans and specifications
• Sales tax included (X%)   — OR —   Sales tax NOT included
• Freight to jobsite included

Exclusions:
• Installation labor by others
• Blocking, backing, and rough-in by others
• Offloading, distribution, and handling by others
• Items not specifically listed above

Notes & Risks:    (only shown if any risks present)
⚠ {risks}

Proposal valid 30 days.

Respectfully,
National Building Specialties — Furnish Only
```

---

## 3. RFQ EMAILS (Sent to Vendors / Manufacturers)

Three flavors all share the same body language. The boilerplate request below is identical in all three.

### 3A. Per-Manufacturer RFQ
**Greeting:** `Dear {Manufacturer} Sales Team,`

### 3B. Group-by-Vendor RFQ (consolidated multi-manufacturer email)
**Greeting:** `Dear {Vendor Name} Team,`
**Extra opener line:**
> *We understand you can quote multiple manufacturer lines we need on this job, so we've consolidated them into a single request.*

### 3C. Open RFQ (estimator picks line items + recipient)
**Greeting:** `{custom greeting from estimator},`

### 3D. Shared RFQ Body (used in all three)

```
National Building Specialties is requesting pricing for the following
Division 10 items on the project below.

PROJECT: {Project Name}
GC: {GC name}
BID DUE: {date}
NBS ESTIMATE #: {estimate #}

{Ship-to address — OR — "[Address not on file — please add to project record]"}

(Optional) SPECIFICATION REQUIREMENTS (from project specs):
   SPECIFICATION REFERENCE: ...
   SPECIFIED MANUFACTURERS: ...
   SUBSTITUTION POLICY: "..."
   KEY REQUIREMENTS:
     • ...

ITEMS REQUESTED:
{table of items}

Please provide:
  1. MATERIAL ONLY unit pricing (NO labor or installation)
  2. Freight cost to jobsite
  3. Lead time / availability
  4. Indicate if pricing includes or excludes sales tax

Pricing Needed By: {date — or "bid due date"}

Thank you,
{Estimator Name}
National Building Specialties
```

---

## 4. AUTO-DEFAULTS WHEN A NEW ESTIMATE IS CREATED

| Field | Default Value | Editable? |
|---|---|---|
| Notes & Risks | *Lead times may extend beyond anticipated start date — verify with vendors* | Yes |
| Assumptions | *(empty list)* | Yes — estimator adds bullets |
| Per-Scope Inclusions | *(blank)* | Yes |
| Per-Scope Exclusions | *(blank)* | Yes |
| Per-Scope Qualifications | *(blank)* | Yes |

---

## 5. SUGGESTED ADDITIONS YOUR BOSS MAY WANT

Common construction-industry boilerplate **NOT currently in the system** that he may want to add:

- *"Freight is based on a single shipment. Subject to change if split shipped."* ← (your example)
- *"Pricing subject to change based on final quantities and field measurements."*
- *"Material pricing subject to manufacturer increases until purchase order is issued."*
- *"Storage on-site by others. Materials must be delivered directly to point of installation."*
- *"Coordination with other trades by others."*
- *"Permits, inspections, and code compliance by others."*
- *"Bonds excluded unless specifically noted."*
- *"Performance / payment bond available upon request at additional cost."*
- *"Quantities based on plans and specifications dated [insert date]."*
- *"Any addenda received after proposal date may affect pricing."*
- *"Payment terms: Net 30 from date of invoice."*
- *"Title to materials remains with NBS until paid in full."*
- *"NBS not responsible for damage to materials after delivery and acceptance."*

Any approved additions can be added to either: **(a)** the hardcoded Inclusions/Exclusions list, **(b)** the default Assumptions list (so they auto-appear on every new estimate), or **(c)** a new "Standard Terms" section.

---

**End of document — ready for review.**
