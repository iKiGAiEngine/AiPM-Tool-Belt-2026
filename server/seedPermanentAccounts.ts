import bcrypt from "bcrypt";
import { db } from "./db";
import { users } from "@shared/schema";
import { sql } from "drizzle-orm";

const PERMANENT_ACCOUNTS = [
  {
    email: "viewonly@aipm.local",
    password: "Viewer1",
    username: "viewonly",
    displayName: "ViewOnly",
    role: "admin" as const,
    isAdmin: true,
    isActive: true,
    status: "active",
  },
];

export async function seedPermanentAccounts(): Promise<void> {
  try {
    for (const account of PERMANENT_ACCOUNTS) {
      const [existing] = await db
        .select({ id: users.id, role: users.role, isAdmin: users.isAdmin })
        .from(users)
        .where(sql`LOWER(${users.email}) = ${account.email.toLowerCase()}`);

      if (!existing) {
        const passwordHash = await bcrypt.hash(account.password, 12);
        await db.insert(users).values({
          email: account.email,
          username: account.username,
          displayName: account.displayName,
          role: account.role,
          isAdmin: account.isAdmin,
          isActive: account.isActive,
          status: account.status,
          mustChangePassword: false,
          passwordHash,
        });
        console.log(`[PermanentAccounts] Created: ${account.email}`);
      } else if (existing.role !== account.role || existing.isAdmin !== account.isAdmin) {
        await db.execute(sql`
          UPDATE users
          SET role = ${account.role}, is_admin = ${account.isAdmin}
          WHERE LOWER(email) = ${account.email.toLowerCase()}
        `);
        console.log(`[PermanentAccounts] Corrected role/isAdmin for: ${account.email}`);
      } else {
        console.log(`[PermanentAccounts] OK: ${account.email}`);
      }
    }
  } catch (error: any) {
    console.error("[PermanentAccounts] Error:", error.message);
  }
}
