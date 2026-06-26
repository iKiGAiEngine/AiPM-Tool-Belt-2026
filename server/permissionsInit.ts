import { db } from "./db";
import { users, userFeatureAccess, DEFAULT_ROLE_FEATURES, permissionProfiles, FEATURES } from "@shared/schema";
import { sql, eq, desc } from "drizzle-orm";

export async function initializePermissions() {
  try {
    // Create tables if they don't exist
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS user_feature_access (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        feature VARCHAR(50) NOT NULL,
        granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS permission_profiles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        features JSONB DEFAULT '[]',
        linked_role VARCHAR(50),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add linked_role column if it doesn't exist (for existing tables)
    try {
      await db.execute(sql`
        ALTER TABLE permission_profiles 
        ADD COLUMN IF NOT EXISTS linked_role VARCHAR(50)
      `);
    } catch (err: any) {
      // Column might already exist, ignore error
    }

    // Create default profiles if they don't exist
    const existingProfiles = await db.select().from(permissionProfiles);
    if (existingProfiles.length === 0) {
      const defaultProfiles = [
        {
          name: "Full Access",
          description: "All features (Admin)",
          linkedRole: "admin",
          features: Object.values(FEATURES),
        },
        {
          name: "Accounting",
          description: "Proposal Log, Vendor Database, Settings",
          linkedRole: "accounting",
          features: [FEATURES.PROPOSAL_LOG, FEATURES.VENDOR_DATABASE, FEATURES.CENTRAL_SETTINGS],
        },
        {
          name: "Project Manager",
          description: "Proposal Log, Submittal Builder, Schedule Converter, Spec Extractor, Quote Parser, Project Start",
          linkedRole: "project_manager",
          features: [
            FEATURES.PROPOSAL_LOG,
            FEATURES.SUBMITTAL_BUILDER,
            FEATURES.SCHEDULE_CONVERTER,
            FEATURES.SPEC_EXTRACTOR,
            FEATURES.QUOTE_PARSER,
            FEATURES.PROJECT_START,
          ],
        },
        {
          name: "Standard User",
          description: "Proposal Log, Submittal Builder",
          linkedRole: "user",
          features: [FEATURES.PROPOSAL_LOG, FEATURES.SUBMITTAL_BUILDER],
        },
        {
          name: "Executive",
          description: "Proposal Log, Project Log, Draft Review",
          linkedRole: null, // Not auto-linked to a role, but available for manual assignment
          features: [
            FEATURES.PROPOSAL_LOG,
            FEATURES.DRAFT_REVIEW,
          ],
        },
      ];

      for (const profile of defaultProfiles) {
        await db.insert(permissionProfiles).values(profile);
      }
      console.log("[Permissions] Created default profiles linked to roles");
    }

    // Add Executive profile if it doesn't exist
    const executiveProfile = await db.select().from(permissionProfiles).where(sql`name = 'Executive'`);
    if (executiveProfile.length === 0) {
      await db.insert(permissionProfiles).values({
        name: "Executive",
        description: "Proposal Log, Project Log, Draft Review",
        linkedRole: null,
        features: [FEATURES.PROPOSAL_LOG, FEATURES.DRAFT_REVIEW],
      });
      console.log("[Permissions] Created Executive profile");
    }

    // Clean up duplicate users (keep the oldest, delete newer duplicates)
    const allUsers = await db.select().from(users).orderBy(users.createdAt);
    const emailMap = new Map<string, number>();
    const duplicatesToDelete: number[] = [];

    for (const user of allUsers) {
      const email = user.email.toLowerCase();
      if (emailMap.has(email)) {
        // This is a duplicate, mark for deletion
        duplicatesToDelete.push(user.id);
      } else {
        emailMap.set(email, user.id);
      }
    }

    if (duplicatesToDelete.length > 0) {
      console.log(`[Permissions] Found ${duplicatesToDelete.length} duplicate users, deleting...`);
      for (const userId of duplicatesToDelete) {
        try {
          // Delete user feature access first
          await db.delete(userFeatureAccess).where(eq(userFeatureAccess.userId, userId));
          // Then delete the user
          await db.delete(users).where(eq(users.id, userId));
          console.log(`[Permissions] Deleted duplicate user ID ${userId}`);
        } catch (err: any) {
          console.error(`[Permissions] Failed to delete user ${userId}:`, err.message);
        }
      }
    }

    // Update Standard User profile to remove submittal-builder (Estimators don't need it)
    await db.execute(sql`
      UPDATE permission_profiles
      SET features = (
        SELECT jsonb_agg(elem)
        FROM jsonb_array_elements(features) AS elem
        WHERE elem::text NOT IN ('"submittal-builder"')
      ),
      updated_at = NOW()
      WHERE linked_role = 'user'
    `);

    // Remove submittal-builder from all Estimator (user role) accounts
    const estimatorUsers = await db.select({ id: users.id }).from(users).where(eq(users.role, "user"));
    for (const eu of estimatorUsers) {
      await db.execute(sql`
        DELETE FROM user_feature_access
        WHERE user_id = ${eu.id} AND feature = 'submittal-builder'
      `);
    }
    if (estimatorUsers.length > 0) {
      console.log(`[Permissions] Removed submittal-builder from ${estimatorUsers.length} Estimator user(s)`);
    }

    // PASS 1: For each user with zero permissions, assign full role defaults.
    // This must run BEFORE any feature-specific seeding so that admins starting from
    // zero rows receive their complete default feature set (which includes all features)
    // rather than only the feature-specific grant applied below.
    const allUsersForDefaults = await db.select().from(users);
    for (const user of allUsersForDefaults) {
      const existingAccess = await db
        .select()
        .from(userFeatureAccess)
        .where(sql`${userFeatureAccess.userId} = ${user.id}`);

      if (existingAccess.length === 0) {
        const defaultFeatures = DEFAULT_ROLE_FEATURES[user.role] || DEFAULT_ROLE_FEATURES.user;
        if (defaultFeatures.length > 0) {
          await db.insert(userFeatureAccess).values(
            defaultFeatures.map((feature) => ({
              userId: user.id,
              feature,
            }))
          );
        }
      }
    }

    // PASS 2: estimating-module — ensure all admins have it (top-up only; PASS 1 already
    // gave it to zero-permission admins via DEFAULT_ROLE_FEATURES.admin).
    // Non-admin users receive this feature only via explicit Permissions UI grant.
    const allAdmins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
    let grantedEstimatingCount = 0;
    for (const au of allAdmins) {
      const existing = await db.execute(sql`
        SELECT id FROM user_feature_access
        WHERE user_id = ${au.id} AND feature = 'estimating-module'
        LIMIT 1
      `);
      if (existing.rows.length === 0) {
        await db.execute(sql`
          INSERT INTO user_feature_access (user_id, feature)
          VALUES (${au.id}, 'estimating-module')
        `);
        grantedEstimatingCount++;
      }
    }
    if (grantedEstimatingCount > 0) {
      console.log(`[Permissions] Granted estimating-module to ${grantedEstimatingCount} Admin user(s)`);
    }

    // Top-up: ensure all admins have procurement-process
    let grantedProcurementCount = 0;
    for (const au of allAdmins) {
      const existing = await db.execute(sql`
        SELECT id FROM user_feature_access
        WHERE user_id = ${au.id} AND feature = 'procurement-process'
        LIMIT 1
      `);
      if (existing.rows.length === 0) {
        await db.execute(sql`
          INSERT INTO user_feature_access (user_id, feature)
          VALUES (${au.id}, 'procurement-process')
        `);
        grantedProcurementCount++;
      }
    }
    if (grantedProcurementCount > 0) {
      console.log(`[Permissions] Granted procurement-process to ${grantedProcurementCount} Admin user(s)`);
    }

    // Top-up: ensure all admins have buyout-bot and tax-rate-lookup
    for (const feature of ["buyout-bot", "tax-rate-lookup"] as const) {
      let grantedCount = 0;
      for (const au of allAdmins) {
        const existing = await db.execute(sql`
          SELECT id FROM user_feature_access
          WHERE user_id = ${au.id} AND feature = ${feature}
          LIMIT 1
        `);
        if (existing.rows.length === 0) {
          await db.execute(sql`
            INSERT INTO user_feature_access (user_id, feature)
            VALUES (${au.id}, ${feature})
          `);
          grantedCount++;
        }
      }
      if (grantedCount > 0) {
        console.log(`[Permissions] Granted ${feature} to ${grantedCount} Admin user(s)`);
      }
    }

    // One-time migration: revoke estimating-module from non-admin users who may have
    // received it via old catch-all defaults. Tracked by a flag in system_settings so
    // subsequent startups do not disturb Permissions UI grants.
    const migrationKey = "estimating-module-non-admin-revoked-v1";
    const migrationDone = await db.execute(sql`
      SELECT value FROM system_settings WHERE key = ${migrationKey} LIMIT 1
    `);
    if (migrationDone.rows.length === 0) {
      const nonAdminUsers = await db.select({ id: users.id }).from(users).where(sql`role != 'admin'`);
      let revokedCount = 0;
      for (const nu of nonAdminUsers) {
        const result = await db.execute(sql`
          DELETE FROM user_feature_access
          WHERE user_id = ${nu.id} AND feature = 'estimating-module'
          RETURNING id
        `);
        if (result.rows.length > 0) revokedCount++;
      }
      await db.execute(sql`
        INSERT INTO system_settings (key, value) VALUES (${migrationKey}, 'done')
        ON CONFLICT (key) DO UPDATE SET value = 'done', updated_at = NOW()
      `);
      if (revokedCount > 0) {
        console.log(`[Permissions] One-time cleanup: revoked estimating-module from ${revokedCount} non-Admin user(s)`);
      }
    }

    // Idempotent: keep users.is_admin column in sync with role.
    // Fixes accounts where role was set to 'admin' but the is_admin flag was never flipped,
    // which previously hid the Admin Dashboard / shield button.
    const isAdminSyncResult = await db.execute(sql`
      UPDATE users
      SET is_admin = (role = 'admin')
      WHERE is_admin IS DISTINCT FROM (role = 'admin')
      RETURNING id
    `);
    if (isAdminSyncResult.rows.length > 0) {
      console.log(`[Permissions] Synced is_admin flag for ${isAdminSyncResult.rows.length} user(s) to match role`);
    }

    console.log("[Permissions] Initialized user feature access");
  } catch (error: any) {
    console.error("[Permissions] Failed to initialize:", error.message);
    // Don't fail startup if permissions table initialization fails
    // The system will still work, just without permission checks
  }
}
