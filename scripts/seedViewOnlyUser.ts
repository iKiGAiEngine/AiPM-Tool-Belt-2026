// Idempotent seed script: creates the shared ViewOnly executive account (role=viewer).
// Safe to re-run — exits cleanly if the account already exists.
import bcrypt from "bcrypt";
import { db } from "../server/db";
import { users } from "../shared/schema";
import { sql } from "drizzle-orm";

async function main() {
  const email = "viewonly@aipm.local";

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`LOWER(${users.email}) = ${email}`);

  if (existing) {
    console.log(`ViewOnly account already exists, id=${existing.id}`);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash("Viewer1", 12);

  const [created] = await db
    .insert(users)
    .values({
      email,
      username: "ViewOnly",
      displayName: "ViewOnly",
      role: "viewer",
      isAdmin: false,
      isActive: true,
      status: "active",
      mustChangePassword: false,
      passwordHash,
    })
    .returning({ id: users.id });

  console.log(`ViewOnly account created, id=${created.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
