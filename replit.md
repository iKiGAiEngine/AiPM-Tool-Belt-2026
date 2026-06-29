# AiPM Tool Belt - Your Ai Assisted APM

## Overview
AiPM Tool Belt is an AI-assisted suite of construction document processing tools aimed at automating manual tasks, enhancing efficiency, and improving accuracy in managing project documentation within the construction industry. It offers a unified project creation workflow and tools for automated extraction of Division 10 specifications (Spec Extractor), OCR-based classification of construction plan pages (Plan Parser), and structured parsing of vendor quotes (Quote Parser). The system is designed to streamline project documentation, from initial setup to generating submittal packages, with a focus on data clarity and robust export functionalities.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend is built with React 18, TypeScript, Wouter for routing, and TanStack React Query for state management. Styling utilizes Tailwind CSS and CSS variables for theming, incorporating shadcn/ui components. The UI prioritizes a professional aesthetic and data clarity, organized into page-based tools.

### Design System
The AiPM Design System uses Rajdhani for headings and DM Sans for body text, featuring a dual dark/light color palette with a gold accent. Components like primary gold-gradient buttons and card accent bars follow specific patterns. Animations are subtle, focusing on fade-in and scale effects.

### Backend
The backend is an Express.js application in TypeScript, managing PDF uploads via Multer and text extraction with pdf-parse. It provides RESTful APIs and integrates modules for specification extraction (`specExtractorEngine.ts`) and OCR processing/classification (`planparser/`).

**Large uploads (chunked):** The production Autoscale ingress proxy rejects request bodies over ~32 MiB. To process spec PDFs of any size, the Spec Extractor uploads large files in chunks (`/api/spec-extractor/upload/init` → `/chunk` → `/complete`, see `shared/uploadLimits.ts` for `UPLOAD_CHUNK_BYTES`). Chunks are reassembled on local disk, so **the Autoscale deployment must be set to max 1 instance** — otherwise chunks for one upload can land on different instances and reassembly fails. (The existing single-instance disk read-back for `<sessionId>.pdf` already assumes this.) Moving to a Reserved VM, or switching to object storage, would remove this constraint.

### Data Storage
All persistent data is stored in PostgreSQL, managed by Drizzle ORM. Key tables include `sessions`, `extracted_sections`, `plan_parser_jobs`, `projects`, `scope_dictionaries`, and `proposal_log_entries`. PDF buffers and template files (folder ZIPs, estimate Excel files) are stored as binary data within the database for production resilience, with a fallback to the filesystem for retrieval.

### Core Logic
- **Spec Extractor**: Automates Division 10 specification extraction using a regex engine with AI enhancement (GPT-4o-mini) for section label review and project name suggestions.
- **Plan Parser**: Classifies construction plan pages using keyword-based scoring and OCR, supporting configurable scope dictionaries and baseline snapshots.
- **Quote Parser**: Structures vendor quotes into an estimate table, performing schedule matching and vendor/manufacturer identification.
- **Project Start System**: Manages project creation, generates unique IDs, sets up project structures, orchestrates spec and plan processing, and supports screenshot OCR for project details.
- **Proposal Log Management**: Provides a dashboard and table for managing project proposals, including inline editing for various fields (e.g., status, notes, estimators, region, market), multi-select scope checklists, and administrative filtering. Includes functionality for managing `selfPerformEstimator` columns with region-specific lists.
- **Central Settings Hub**: An administrative interface for managing scope dictionaries, regional identifiers, vendor profiles, product dictionaries, and Spec Extractor configurations, with bulk import capabilities.
- **Template Management**: Handles uploading and versioning of folder structures and Excel templates, including Excel stamping with project data.
- **Project Log**: An immutable audit trail of proposal log entries with filtering, sorting, searching, and export.
- **Google Sheet Sync**: Bi-directional synchronization between the Proposal Log database and a Google Sheet.
- **Nightly Backup**: Automated daily backups of the Proposal Log in .xlsx format.
- **Schedule Converter**: Transforms schedule screenshots or text into structured data using AI vision models (GPT-4o), with verification and export features.
- **Submittal Builder**: A tool for assembling and exporting Division 10 submittal packages, persisting data in `localStorage` and featuring a multi-panel workspace for schedule editing, product data attachment, cover page generation, validation, and preview/export.
- **Vendor / Manufacturer Database**: A full CRUD module for managing Division 10 manufacturer and vendor profiles. Three-tab UI: Vendors tab (searchable list with detail view for contacts, products, pricing, logistics, tax info, files), Manufacturers tab (admin list of every record in `mfr_manufacturers` with vendor/line-item/approved-scope counts; supports rename — auto-syncs cached `mfr` text on linked line items — merge — re-points line items, vendor tag arrays, legacy join rows, and approved scope entries from source to target then deletes source — and delete with usage warning), and Certificate Tracker tab (resale cert lifecycle: sent → confirmed → tracking expiration). Supports bulk Excel upload of NBS manufacturer list. Stores data in `mfr_vendors`, `mfr_manufacturers`, `mfr_contacts`, `mfr_products`, `mfr_pricing`, `mfr_logistics`, `mfr_tax_info`, `mfr_resale_certs`, `mfr_files` tables.
- **Project Export**: Supports downloading project folders as ZIP files, generating ZIP archives with spec extract PDFs and plan pages, and creating bookmarked or per-scope PDFs.
- **BuildingConnected Integration**: OAuth 2.0 integration for connecting BuildingConnected accounts, allowing admin-only opportunity synchronization with preview/confirm workflows and draft proposal log entry creation.
- **Notification System**: In-app notifications with real-time updates and read/unread management.
- **Draft Review & Project Start**: Manages draft proposal log entries from BC sync, enabling admin review, approval (creating projects and generating estimate numbers), and rejection.
- **Line-Item Manufacturer Combo**: The manufacturer field on every estimate line item (both the inline Add Item form and the line items table) is a typeahead dropdown backed by the global `mfr_manufacturers` table rather than free text. The dropdown lists all manufacturers, with the current scope's Approved Manufacturers shown first (marked ★). On blur, the entered text is matched case-insensitively against the global list; an exact match links the line item to that manufacturer record (storing both `mfr` text and `manufacturer_id` FK on `estimate_line_items`); a non-empty value with no match auto-creates a manufacturer record via the idempotent `POST /api/mfr/manufacturers` upsert and links it. This keeps the global manufacturer list in sync, eliminates fuzzy-match drift between line items and the Approved Manufacturers picker, and gives RFQ generation a stable manufacturer reference.
- **RFQ Group-by-Vendor & Open RFQ**: The RFQ Generator panel has two productivity boosters. (1) A **Group by Vendor** toggle inverts the cards from per-manufacturer to per-eligible-vendor — each vendor card shows every approved/discovered manufacturer they can quote for the active scope, with their line-item counts, and a single "Pick Recipients & Send" button that produces one consolidated email grouped by manufacturer (so PBS doesn't get three separate Bobrick/Bradley/ASI emails). Eligibility uses the same vendor-tag rules as per-mfr cards. (2) An **Open RFQ** modal lets estimators tick any subset of the active scope's line items and send to any vendor (existing — typeahead from the global vendor list, defaulting to the primary contact's email — or one-time vendor entered free-form with name + email). Supports an optional notes field for accessory lists or special instructions; one-time vendors are NOT saved to the database.
- **Scope-Aware Vendor Priority (Open RFQ + Per-Mfr Picker)**: Vendor pickers inside the Estimating Module rank vendors by relevance to the active scope/estimate instead of dumping every vendor in the database. Open RFQ "Existing vendor" mode sorts vendors A→D: (A) vendors that have already received an RFQ for this estimate+scope, (B) vendors tagged for the active scope, (C) vendors tagged to a manufacturer that appears on the selected line items (or all line items if none are checked), (D) every other vendor. By default only A/B/C are shown; a "Show all vendors" toggle reveals D, with a hidden-count badge. Manufacturer-direct sort is preserved as the tiebreaker within each rank, and search works in both modes (placeholder text and helper text update accordingly). Rank A is sourced from the new read-only endpoint `GET /api/estimates/:id/scopes/:scope/rfq-used-vendor-ids`, which joins `rfq_log.recipient_emails` ↔ `mfr_contacts.email` (case-insensitive) → vendor IDs and fails safely with `[]` on any error so the picker degrades gracefully. The per-Manufacturer "Pick Recipients & Send" recipient picker also gained a visual-only search input that filters which vendor groups/contacts are *displayed* without altering pre-checked contacts, the per-vendor "select all" semantics (which always operate on the full group), or the recipient list that is sent — search is purely cosmetic.
- **RFQ Vendor Lookup (Approved Manufacturers)**: Per-scope curated manufacturer list inside the Estimating Module. Each scope tab has an "Approved Manufacturers" card where estimators add manufacturers from the global database (with inline create-and-auto-select for new ones) and optionally flag a Basis of Design. The RFQ Generator combines approved manufacturers with any manufacturers found on line items (de-duplicated via case-insensitive 3-character-minimum substring match, strict equality below 3). Per-card "Pick Recipients & Send" button opens a recipient picker modal grouped by vendor with per-vendor and master select-all (indeterminate states supported); a vendor is eligible when (vendor has no scope tags OR includes the active scope) AND (vendor has no manufacturer tags OR includes this manufacturer); when a vendor is eligible, ALL of its contacts are eligible recipients. All eligible contacts are pre-checked on every open; only ticked contacts with emails are added to the `mailto:` To: line. Button is disabled when 0 eligible contacts. Vendor tags (`scopes text[]`, `manufacturer_ids integer[]`) live on `mfr_vendors` and are managed inline in the Vendor Database General Info section via `ScopeTagPicker` and `ManufacturerTagPicker`. Individual contacts are simply representatives of their parent vendor — they no longer carry their own scope or manufacturer tags. Persists in `estimate_scope_manufacturers` (unique on estimate+scope+manufacturer, FK cascade on manufacturer delete). Gated by the `rfq-vendor-lookup` feature flag — off by default, granted per user via the admin permissions page.
- **Estimating Module Mobile Layout**: The Line Items stage uses horizontal scroll on small viewports rather than stacked cards. The Add Item form and line items table both keep their full-width desktop layouts; their containers are wrapped in `overflow-x-auto` and the table carries an explicit `min-width` so that on a phone the user simply scrolls right to see every column rather than having data crammed or hidden. (A legacy stacked-card mobile branch is gated behind `false && isMobile` and intentionally not rendered.)
- **Vendor Quote AI Extraction (V1)**: Bolt-on AI extraction workflow for existing estimate quote cards. When a PDF/image backup is attached to a quote, AI extraction automatically triggers (GPT-4o-mini for PDFs, GPT-4o for images). Stores extracted header info and per-row line items in `vendor_quote_line_items` with per-row confidence scores. Routes to `needs_review` (low confidence) or `ready_for_approval`. Review modal shows editable extracted rows table with confidence badges, a View PDF button, and approve action that creates estimate line items and persists mappings in `vendor_quote_to_estimate_line_item_map`. Status badges on each quote card reflect the extraction lifecycle: uploaded → processing → needs_review / ready_for_approval → approved / failed.

### Authentication & Access Control
- **OTP Email Login**: Secure login via 6-digit email codes.
- **Role-Based Access**: Features are gated by `isAdmin` checks.
- **Session Management**: PostgreSQL-backed sessions with secure cookies.
- **Admin Dashboard**: Manages users, roles, audit logs, and provides data backup/recovery functionalities.
- **Audit Logging**: Logs all authentication and admin actions.
- **Rate Limiting**: In-memory rate limiting for OTP requests.

## External Dependencies

### Core Libraries
- **pdfjs-dist**: PDF text extraction.
- **pdf-lib**: PDF manipulation.
- **tesseract.js**: OCR engine.
- **Drizzle ORM**: PostgreSQL ORM.
- **Zod**: Schema validation.
- **TanStack Query**: Asynchronous state management.
- **ExcelJS**: Server-side Excel file handling.
- **xlsx**: Client-side Excel file generation.
- **JSZip**: ZIP file generation.
- **OpenAI GPT-4o-mini/GPT-4o**: AI vision model.

### UI Components
- **Radix UI**: Accessible component primitives.
- **shadcn/ui**: Pre-styled component library.
- **Lucide React**: Icon library.

### Database
- **PostgreSQL**: Primary data store.