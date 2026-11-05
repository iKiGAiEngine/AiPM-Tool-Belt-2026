# AiPM Tool Belt — Changelog

## [11-05-2026] Disaster-recovery backup to Swinerton SharePoint / OneDrive
### Added
- Full, self-contained backups uploaded automatically to a Swinerton-owned SharePoint site (or OneDrive) through Microsoft Graph: every database table (found automatically), stored files, server-disk files, application source code, deployment settings, and restore guides
- Consistent point-in-time database snapshot, plus a second standard `pg_dump` copy and a readable Excel copy
- SHA-256 checksum manifest; uploads go to a holding folder and only move into `Backups/` once every file is confirmed
- Retention: everything from the last 48 h, 1 per day for 30 days, 1 per month for 12 months (configurable)
- `scripts/dr-restore.ts`: verifies a backup, then rebuilds the database in one all-or-nothing step and compares row counts; also unpacks server files
- `scripts/dr-backup.ts`: command-line backup (for Replit Scheduled Deployments)
- Admin → Data Backup & Recovery: status card, Back up now, Test connection, run history
- Power Automate trigger (`POST /api/dr-backup/trigger`, start-and-poll pattern); failure email to the admin
- Runbook and IT setup guide: `docs/DISASTER_RECOVERY.md`

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
