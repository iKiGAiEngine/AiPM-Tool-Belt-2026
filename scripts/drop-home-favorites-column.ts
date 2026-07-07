// One-off migration: deliberately drop the orphaned `users.home_favorites` column.
//
// Background: the "pinnable homepage Favorites" feature (commit 4df1811) added a
// `home_favorites` text column to the users table plus API routes and UI. The
// feature was later fully removed from the codebase — no server or client code
// references it anymore, and it is absent from shared/schema.ts. The code revert
// never dropped the DB column, so production still carries `home_favorites` with
// orphaned data. That drift makes `npm run db:push` offer to drop the column as an
// unattended side effect (a data-loss prompt during unrelated deploys).
//
// This script performs that drop DELIBERATELY and reviewably instead:
//   1. Archives every non-null row into `_archived_home_favorites` (recoverable).
//   2. Drops the column.
// It is idempotent — safe to run more than once. After it runs, db:push sees no
// drift for this column and stops prompting.
//
// Run once against the target database:
//   DATABASE_URL=... tsx scripts/drop-home-favorites-column.ts
//
// To recover archived data later: SELECT * FROM _archived_home_favorites;
// To discard the archive once you're satisfied: DROP TABLE _archived_home_favorites;

import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  // 1. Does the column still exist? (idempotency)
  const colCheck = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'home_favorites'
  `);
  if (colCheck.rows.length === 0) {
    console.log("[drop-home-favorites] Column users.home_favorites already gone — nothing to do.");
    return;
  }

  // 2. Archive non-null rows before the destructive change.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS _archived_home_favorites (
      user_id integer,
      home_favorites text,
      archived_at timestamp NOT NULL DEFAULT now()
    )
  `);
  const archived = await db.execute(sql`
    INSERT INTO _archived_home_favorites (user_id, home_favorites)
    SELECT id, home_favorites FROM users WHERE home_favorites IS NOT NULL
    RETURNING user_id
  `);
  console.log(`[drop-home-favorites] Archived ${archived.rows.length} row(s) into _archived_home_favorites.`);

  // 3. Drop the orphaned column.
  await db.execute(sql`ALTER TABLE users DROP COLUMN IF EXISTS home_favorites`);
  console.log("[drop-home-favorites] Dropped column users.home_favorites.");
  console.log("[drop-home-favorites] Done. `npm run db:push` will no longer prompt about this column.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[drop-home-favorites] Failed:", err);
    process.exit(1);
  });
