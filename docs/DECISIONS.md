# AiPM Tool Belt — Architectural Decisions

## [04-06-2026] — OTP Email Login Instead of Passwords
**What:** Authentication uses 6-digit codes sent via email instead of usernames and passwords.
**Why:** Eliminates password complexity requirements, eliminates password reset flows, reduces credential compromise risk, and enables quick testing with pre-configured users. OTP codes are rate-limited (5 per email per hour) and expire after use.
**Alternatives rejected:** Password-based login (higher compromise risk, requires reset flows); OAuth-only login (requires external provider dependency); Magic links (longer URLs, harder to enter on mobile).

## [04-06-2026] — PostgreSQL + Drizzle ORM for Data Persistence
**What:** All application data stored in PostgreSQL using Drizzle ORM with type-safe schema definitions.
**Why:** PostgreSQL provides ACID guarantees for proposal log data integrity, Drizzle ORM provides TypeScript-first database access without runtime SQL queries, and schema-as-code enables version control of database structure. Zod validation at runtime ensures data conforms to expected types before storage.
**Alternatives rejected:** MongoDB (no ACID; proposal log data requires strong consistency); Firebase (vendor lock-in; limited query flexibility); raw SQL (no type safety; error-prone).

## [04-06-2026] — Role-Based Access Control (RBAC) with Permission Profiles
**What:** Users are assigned roles (admin, user, accounting, project_manager), and each role grants access to specific features via permission profiles.
**Why:** Allows rapid feature assignment to groups of users without touching code. Permission profiles can be linked to roles so changing a user's role automatically applies the correct feature set. Reduces admin overhead and prevents manual feature assignment errors.
**Alternatives rejected:** Feature-level only (no grouping; tedious admin work); Attribute-based access (too complex for small teams); Hardcoded role checks (not flexible).

## [04-06-2026] — Project Ownership for Write/Delete Access Control
**What:** Proposal log entries track the user who created the project (createdBy field). PATCH and DELETE operations verify the request user matches the owner or is an admin.
**Why:** Prevents users from modifying or deleting other users' proposals. Admins bypass ownership checks to unblock situations. Keeps data isolated by user while maintaining admin oversight.
**Alternatives rejected:** Shared edit access (too permissive); role-based filtering (users could still modify others' data if same role); no access control (security risk).

## [04-06-2026] — Open Read Access + Restricted Write Access
**What:** Proposal log GET endpoints return all entries to all authenticated users. Only PATCH/DELETE operations enforce ownership checks.
**Why:** Allows visibility across the team (estimators see what reviewers are working on) while preventing accidental or malicious data modification. Aligns with business process: estimators collaborate but own their own estimates.
**Alternatives rejected:** Complete filtering by user (data silos; team can't see overall progress); write-only access (estimators can't see their own data); read-only access (no tool value).

## [04-06-2026] — Session-Based Authentication with PostgreSQL Session Store
**What:** Express sessions stored in PostgreSQL via connect-pg-simple with secure HTTP-only cookies.
**Why:** Survives application restarts, no in-memory loss, works across multiple server instances, database-native expiration. SESSION_SECRET environment variable encrypts session cookies.
**Alternatives rejected:** JWT (stateless but can't revoke; harder to track sessions); Redis (external dependency; doesn't survive infrastructure restarts); in-memory (lost on restart).

## [04-06-2026] — Drizzle ORM Schema as TypeScript Code
**What:** Database tables defined as TypeScript in shared/schema.ts, not as SQL migrations.
**Why:** Single source of truth for schema; TypeScript types derived from schema automatically; Drizzle migrations generated from schema changes; enables safe schema validation with Zod.
**Alternatives rejected:** Raw SQL migrations (easy to miss type sync); ORM with separate migrations (version sync risk); schema-less (no type safety).

## [04-06-2026] — Zod Runtime Validation for API Inputs
**What:** Every API route validates request body/params using Zod schemas before processing.
**Why:** Catches malformed data before hitting database; provides consistent error messages; schemas generated from Drizzle schema using drizzle-zod; fails fast on bad input.
**Alternatives rejected:** No validation (corrupted data reaches database); JSON.parse only (allows invalid data types); custom validators (verbose, error-prone).

## [04-06-2026] — Proposal Log Ownership Tracked by project.createdBy Field
**What:** The projects table stores a createdBy field (string) containing the user's displayName or email. Proposal entries reference this via projectDbId.
**Why:** Enables querying all proposals created by a user; enables audit trail; simple string comparison in ownership checks; survives user ID changes (uses displayName/email, not numeric ID).
**Alternatives rejected:** userIds in numeric columns (requires user ID enumeration); email-only (displayName might be preferred in UI); multi-creator (overcomplicates ownership).

## [04-06-2026] — Admin Bypass for All Access Controls
**What:** Admins skip all ownership checks and can view, edit, delete any proposal.
**Why:** Unblocks support scenarios (fixing user mistakes, auditing data); allows data cleanup; enables admin oversight. Admins verified via role = 'admin' on every request.
**Alternatives rejected:** Shared ownership model (doesn't empower admins); read-only audit (can't fix data); no admin bypass (too restrictive).

## [04-06-2026] — Google Sheets API for Bi-Directional Proposal Log Sync
**What:** Proposal log entries sync to a Google Sheet; updates on either side sync to the other.
**Why:** Allows users to work in sheets (familiar tool); provides offline-capable backup; enables bulk updates via Sheet; automatic nightly backups to .xlsx format.
**Alternatives rejected:** One-way export (no feedback loop); no sync (no sheet access); API-only (no offline backup).

## [04-06-2026] — BuildingConnected OAuth 2.0 for Opportunity Import
**What:** Admin users can authorize their BuildingConnected account via OAuth, then sync opportunities to draft proposal entries.
**Why:** Reduces manual data entry; brings external opportunity data into the system; draft entries enable review before full project creation.
**Alternatives rejected:** API key (less secure; no user-specific auth); manual CSV import (tedious); no integration (data silos).

## [04-06-2026] — Audit Logging for Authentication and Admin Actions
**What:** All login attempts, user changes, and admin actions logged with timestamp, actor, action type, and summary.
**Why:** Enables investigation of issues; provides accountability; helps detect unauthorized access; supports compliance.
**Alternatives rejected:** No logging (no audit trail); logging to files (hard to query); logging only errors (misses normal operations).

## [04-06-2026] — Manual Changelog Updates (Not Automated)
**What:** Changelog is updated manually at end of each build session via /changelog route (admin only).
**Why:** Ensures changelog captures intent and reasoning (not just diff); prevents noise from auto-generation; forces reflection on what was built; changelog becomes part of code review.
**Alternatives rejected:** Auto-detection from git (captures code changes, not intent); auto-generation from tickets (requires ticket system); continuous updates (too noisy).

## [04-06-2026] — Soft Delete for Proposal Log Entries
**What:** Deleted entries marked with deletedAt timestamp instead of hard removed from database.
**Why:** Preserves audit trail; enables recovery; maintains referential integrity; enables filtering active vs deleted entries.
**Alternatives rejected:** Hard delete (loses history); archive table (duplicate management); logical deletion in code (no database-level enforcement).

## [04-06-2026] — Spec Extractor with GPT-4o and Regex Engine
**What:** Division 10 specifications extracted by regex pattern matching, with GPT-4o used for label review and project name suggestion.
**Why:** Regex fast and accurate for structured spec format; GPT-4o adds intelligence for edge cases. Hybrid approach balances speed and accuracy.
**Alternatives rejected:** Regex only (misses edge cases); GPT-4o only (slow and expensive); template matching (inflexible).

## [04-06-2026] — User.id as Serial Primary Key (Non-Negotiable)
**What:** The users table uses serial (auto-incrementing integer) as primary key, not UUID.
**Why:** Drizzle ORM and session store depend on this type; changing it breaks foreign key relationships; simpler indices and queries.
**Alternatives rejected:** UUID (migration risk; session store breaks); composite keys (overcomplicates relationships).

## [04-06-2026] — Projects.id as Serial Primary Key (Non-Negotiable)
**What:** The projects table uses serial (auto-incrementing integer) as primary key.
**Why:** Matches user.id constraint; enables fast lookups; supports foreign keys in dependent tables.
**Alternatives rejected:** UUID (migration risk); projectId string field (can't be primary key).

## [04-06-2026] — Duplicate User Account Auto-Cleanup on Startup
**What:** Application checks for duplicate user emails on startup, keeps oldest account, deletes newer duplicates.
**Why:** Prevents session/permission conflicts; ensures single source of truth per email; automatic recovery from data entry mistakes.
**Alternatives rejected:** No cleanup (stale sessions accumulate); manual cleanup (burden on admin); deduplication in queries (slower, incomplete).

## [11-14-2026] — Human-in-the-Loop: "The Customer Is Always Right in Matters of Taste"
**What:** All AI output is sorted into Facts (AI extracts, human verifies), Judgment (AI suggests, human approves), and Taste & Preference (human only — AI never auto-picks). Full requirements in `docs/HITL-REQUIREMENTS.md` (HITL-01 to HITL-31).
**Why:** AI is reliable at copying what's on a page but not at calls driven by customer preference, relationships, or business strategy. Keeping humans in charge of those protects accuracy and customer trust.
**Alternatives rejected:** Full auto-commit of AI results (silent errors reach estimates/customers); AI-ranked preferences (pushes one model's "taste" onto every estimator and customer).
