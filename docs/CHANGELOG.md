# AiPM Tool Belt — Changelog

## [07-09-2026] Quote Parser overhaul — three-gate QC system
### Added
- Verdict banner on every parse: VERIFIED or NEEDS REVIEW with an itemized flag list — every number is proven or flagged
- Gate 1 (math): per-line unit/extended prices + tax extracted; server re-checks qty × unit vs. extension and line sum vs. material total
- Gate 3 (schedule): new Plan Schedule input (PDF/image/text); fills PLAN CALLOUT and flags missing items, extras, and quantity mismatches vs. the plan
- Multi-source input: quote file + pasted screenshot + pasted text combine into one parse; spec accepts images
- Parse run log (`quote_parser_runs`) and vendor price history (`vendor_price_history`) for accuracy tracking and price-trend analysis (run `npm run db:push`)
- Learning loop: 👍/👎 recorded per run, complaints auto-attach quote text, "Draft Rule with AI" turns feedback into per-vendor parsing rules injected on future parses
- Accuracy scorecard + vendor rules editor in Central Settings → Quote Parser
- Click-to-edit result cells (callout, description, model, qty) before copy/export
- Self-test suite: `npx tsx scripts/quoteparser-test.ts`
### Fixed
- Scanned PDFs now parse (pages rendered via pdfjs+canvas to the vision model; old path needed a `pdftoppm` binary absent in production)
- iPhone HEIC photos converted to PNG before vision (previously crashed)
- PDF text extraction keeps rows/columns (was collapsing each page to one line)
- Strict structured outputs + automatic repair retry (was prompt-and-pray JSON)
- Grand-total fallback now subtracts tax as well as freight
- Tag/decal lines fold into their parent product again ("- tagged", "decals included")
### Security
- Admin lock on the AI Handbook, feedback administration, and vendor-rules endpoints
- Input size caps on quote/spec/schedule text
### Removed
- ~560 lines of dead code (pre-AI regex parser, unwired schedule matcher, tesseract OCR path)

## [04-06-2026] v0.1.0
### Added
- OTP-based email authentication system with 6-digit codes
- PostgreSQL database with 26+ tables using Drizzle ORM
- Role-based access control (RBAC) with 4 core roles: admin, user, accounting, project_manager
- Permission profiles system with feature-level access control
- Proposal log HUD (main interface) with 35+ customizable fields
- Project management system with unique IDs and folder structures
- Spec Extractor for automated Division 10 specification extraction (GPT-4o)
- Quote Parser for structured vendor quote parsing
- Plan Parser for OCR-based construction plan classification
- Schedule Converter with AI vision models for schedule screenshot parsing
- Submittal Builder for Division 10 submittal package assembly
- Vendor/Manufacturer Database with contact, product, pricing, and logistics management
- Project Start workflow orchestrating spec and plan processing
- Google Sheets API bi-directional synchronization for proposal log
- BuildingConnected OAuth 2.0 integration for opportunity sync
- Audit logging for all authentication and admin actions
- Project isolation with ownership-based write/delete restrictions
- Session management with PostgreSQL session store (connect-pg-simple)
- Rate limiting for OTP requests (5 attempts per email per hour)
- Quick-login test mode with 8 pre-configured users
- Scope dictionaries for Division 10 classification
- Template management for folder structures and Excel estimates
- Project change audit trail with oldValue/newValue tracking
- Proposal log acknowledgements for read receipts
- Admin user management dashboard with role assignment
- Admin permission profile management with role linking

### Changed
- PATCH /api/proposal-log/entry/:id — Now restricted to project owner or admin (ownership check added)
- DELETE /api/proposal-log/entry/:id — Now restricted to project owner or admin (ownership check added)
- POST /api/proposal-log/delete-bulk — Now enforces ownership checks on all bulk deletions
- User role changes now auto-apply linked permission profiles instead of requiring manual feature assignment
- Project creation workflow now stores screenshot files to database for persistence
- Duplicate user accounts now auto-deduplicated on every startup (keeps oldest, removes newer duplicates)

### Fixed
- Screenshots were previously only used for OCR extraction but not persisted — now properly saved to database during project creation
- Project screenshots can now be retrieved via GET /api/proposal-log/screenshot/:projectId endpoint
- User state was persisting stale sessions — duplicate accounts now cleaned up automatically
- Proposal log entries lacked proper ownership tracking — now linked via projectDbId FK to projects.createdBy

### Notes
- Project ownership determined by comparing project.createdBy (string) to user.displayName or user.email
- Admins bypass all ownership checks — can view, edit, and delete any proposal
- Viewing proposals and screenshots remains open to all users (intentional, no filtering)
- Only write/delete operations enforce ownership restrictions
- Permission profiles can be linked to roles for auto-application on role change
- Executive profile exists but is not linked to any role (manual assignment only)
- Proposal log viewing returns ALL proposals to all users (no filtering applied)
- Session encryption key stored in SESSION_SECRET environment variable
- OPENAI_API_KEY required for GPT-4o calls (spec extraction, schedule conversion)
- PostgreSQL database connection via DATABASE_URL environment variable
- Application uses Zod for runtime validation on all API inputs
