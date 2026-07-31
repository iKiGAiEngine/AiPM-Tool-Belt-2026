#!/bin/bash
set -e

# Runs automatically after every git pull/merge (wired up in .replit).
#
# Keep this to operations that are safe to run unattended. It deliberately does
# NOT run `npm run db:push`: drizzle-kit push rewrites the database to match
# shared/schema.ts, and this database contains tables and a column that were
# never added to that file (bid_docs_files, bid_docs_runs,
# scope_dictionaries.callout_prefixes). Push therefore offers to DROP them, rows
# and all, on every single pull — one stray keypress away from data loss.
#
# Schema additions are applied at boot instead, by the idempotent
# `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements in server/seedData.ts.
#
# If you ever do need a full schema sync, run `npm run db:push` by hand, read
# what it proposes, and abort if it wants to drop anything you still need.
npm install
