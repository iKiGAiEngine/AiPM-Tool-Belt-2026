import type { Express, Request, Response } from "express";
import { db } from "./db";
import { users, auditLogs, FEATURES, DEFAULT_ROLE_FEATURES, Feature, permissionProfiles, userFeatureAccess, portfolioVisits } from "@shared/schema";
import { eq, desc, and, gte, lte, like, or, sql, inArray } from "drizzle-orm";
import bcrypt from "bcrypt";
import { requireAdmin, isAllowedDomain } from "./authRoutes";
import { auditLog } from "./auditService";
import { randomBytes, createHash } from "crypto";
import { sendInviteEmail } from "./emailService";

import { storage } from "./storage";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function registerAdminRoutes(app: Express) {
  app.get("/api/admin/portfolio-visits", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const visits = await db.select().from(portfolioVisits).orderBy(desc(portfolioVisits.visitedAt)).limit(500);
      const total = await db.select({ count: sql<number>`count(*)::int` }).from(portfolioVisits);
      const uniqueIps = await db.select({ count: sql<number>`count(distinct ip)::int` }).from(portfolioVisits);
      res.json({
        total: total[0]?.count ?? 0,
        uniqueIps: uniqueIps[0]?.count ?? 0,
        visits,
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to load visits" });
    }
  });

  app.get("/api/admin/users", requireAdmin, async (req: Request, res: Response) => {
    try {
      const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));
      res.json(allUsers);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  app.patch("/api/admin/users/:id/toggle-active", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params.id);
      const actorId = (req.session as any)?.userId;

      if (actorId === userId) {
        return res.status(400).json({ message: "You cannot deactivate your own account" });
      }

      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) return res.status(404).json({ message: "User not found" });

      const newActive = !user.isActive;
      const newStatus = newActive ? "active" : "inactive";
      const [updated] = await db
        .update(users)
        .set({ isActive: newActive, status: newStatus })
        .where(eq(users.id, userId))
        .returning();

      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: updated.isActive ? "user_activated" : "user_deactivated",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "user",
        entityId: String(userId),
        summary: `${updated.isActive ? "Activated" : "Deactivated"} user ${updated.email}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  app.patch("/api/admin/users/:id/role", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params.id);
      const { role } = req.body;
      const actorId = (req.session as any)?.userId;

      // Lock the shared ViewOnly test account — its role must always stay viewer
      const [targetUser] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
      if (targetUser?.email?.toLowerCase() === "viewonly@aipm.local") {
        return res.status(400).json({ message: "The ViewOnly account role is locked and cannot be changed." });
      }

      if (!["user", "admin", "accounting", "project_manager", "viewer"].includes(role)) {
        return res.status(400).json({ message: "Invalid role" });
      }

      if (actorId === userId && role !== "admin") {
        return res.status(400).json({ message: "You cannot demote yourself" });
      }

      const [updated] = await db
        .update(users)
        .set({ role, isAdmin: role === "admin" })
        .where(eq(users.id, userId))
        .returning();

      if (!updated) return res.status(404).json({ message: "User not found" });

      // Find and apply the profile linked to this role
      const [linkedProfile] = await db
        .select()
        .from(permissionProfiles)
        .where(eq(permissionProfiles.linkedRole, role));

      if (linkedProfile) {
        // Apply the linked profile's features to the user
        await storage.setUserFeatureAccess(userId, linkedProfile.features);
      } else {
        // Fall back to role-based defaults if no linked profile
        const defaultFeatures = DEFAULT_ROLE_FEATURES[role] || DEFAULT_ROLE_FEATURES.user;
        await storage.setUserFeatureAccess(userId, defaultFeatures);
      }

      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "user_role_changed",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "user",
        entityId: String(userId),
        summary: `Changed role of ${updated.email} to ${role}${linkedProfile ? ` (applied profile: ${linkedProfile.name})` : ""}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update role" });
    }
  });

  app.get("/api/estimators", async (_req: Request, res: Response) => {
    try {
      const activeUsers = await db.select({
        id: users.id,
        displayName: users.displayName,
        initials: users.initials,
        email: users.email,
        role: users.role,
      }).from(users).where(eq(users.isActive, true));

      const estimators = activeUsers
        .filter(u => u.initials)
        .map(u => ({
          code: u.initials!,
          label: `${u.initials} — ${u.displayName || u.email}`,
          isAdmin: u.role === "admin",
        }));

      res.json(estimators);
    } catch (error) {
      console.error("[Admin] Get estimators error:", error);
      res.status(500).json({ message: "Failed to get estimators" });
    }
  });

  app.post("/api/admin/users", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { email, displayName, initials, role } = req.body;
      const actorId = (req.session as any)?.userId;

      if (!email || typeof email !== "string") {
        return res.status(400).json({ message: "Email is required" });
      }

      const normalizedEmail = email.trim().toLowerCase();

      if (!isAllowedDomain(normalizedEmail)) {
        return res.status(400).json({ message: "Email domain is not in the allowed list" });
      }

      const [existing] = await db.select().from(users).where(eq(users.email, normalizedEmail));
      if (existing) {
        return res.status(409).json({ message: "A user with this email already exists" });
      }

      const autoInitials = initials || (displayName ? displayName.split(/\s+/).map((w: string) => w[0]).join("").toUpperCase().substring(0, 3) : "");

      const rawInviteToken = randomBytes(32).toString("hex");
      const inviteTokenHash = hashToken(rawInviteToken);
      const inviteExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

      const [newUser] = await db.insert(users).values({
        email: normalizedEmail,
        displayName: displayName || null,
        initials: autoInitials || null,
        role: role || "user",
        isActive: false,
        status: "invited",
        resetToken: inviteTokenHash,
        resetTokenExpiresAt: inviteExpiresAt,
      }).returning();

      let emailWarning: string | undefined;
      try {
        await sendInviteEmail(normalizedEmail, rawInviteToken);
      } catch (err: any) {
        console.error("[Admin] Failed to send invite email:", err.message);
        emailWarning = "User created but invite email could not be sent. Use Resend Invite to retry.";
      }

      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "user_created",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "user",
        entityId: String(newUser.id),
        summary: `Invited user ${newUser.email}${newUser.displayName ? ` (${newUser.displayName})` : ""}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.status(201).json({ ...newUser, ...(emailWarning ? { warning: emailWarning } : {}) });
    } catch (error) {
      console.error("[Admin] Create user error:", error);
      res.status(500).json({ message: "Failed to create user" });
    }
  });

  app.post("/api/admin/users/bulk-set-temp-password", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { tempPassword, includeInactive } = req.body || {};
      const actorId = (req.session as any)?.userId;
      if (!tempPassword || typeof tempPassword !== "string" || tempPassword.length < 8) {
        return res.status(400).json({ message: "Temporary password must be at least 8 characters" });
      }
      const hash = await bcrypt.hash(tempPassword, 12);
      const allUsers = await db.select().from(users);
      const targets = allUsers.filter((u) => u.id !== actorId && (includeInactive ? true : u.isActive));
      if (targets.length === 0) {
        return res.json({ updated: 0, emails: [] });
      }
      await db.update(users).set({
        passwordHash: hash,
        mustChangePassword: true,
        status: "active",
        isActive: true,
        resetToken: null,
        resetTokenExpiresAt: null,
      }).where(inArray(users.id, targets.map((t) => t.id)));

      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "bulk_temp_password_set",
        actorUserId: actorId,
        actorEmail: actor?.email,
        summary: `Set temporary password for ${targets.length} user(s); they must change on next login`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json({ updated: targets.length, emails: targets.map((t) => t.email) });
    } catch (error: any) {
      console.error("[Admin] Bulk temp password error:", error);
      res.status(500).json({ message: "Failed to set temporary passwords" });
    }
  });

  app.post("/api/admin/users/:id/resend-invite", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params.id);
      const actorId = (req.session as any)?.userId;
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const rawInviteToken = randomBytes(32).toString("hex");
      const inviteTokenHash = hashToken(rawInviteToken);
      const inviteExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

      await db.update(users).set({
        status: "invited",
        isActive: false,
        resetToken: inviteTokenHash,
        resetTokenExpiresAt: inviteExpiresAt,
      }).where(eq(users.id, userId));

      await sendInviteEmail(user.email, rawInviteToken);

      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "invite_resent",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "user",
        entityId: String(user.id),
        summary: `Resent invite to ${user.email}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });
      await db.insert(auditLogs).values({
        actionType: "invite_email_sent",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "user",
        entityId: String(user.id),
        summary: `Invite email sent to ${user.email}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json({ message: "Invite sent" });
    } catch (error: any) {
      console.error("[Admin] Resend invite error:", error);
      res.status(500).json({ message: "Failed to resend invite" });
    }
  });

  app.patch("/api/admin/users/:id/profile", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params.id);
      const { displayName, initials, email, role, dashboardScope, dashboardLayout, assignedRegion } = req.body;
      const actorId = (req.session as any)?.userId;

      const updateFields: Record<string, any> = {};
      if (displayName !== undefined) updateFields.displayName = displayName || null;
      if (initials !== undefined) updateFields.initials = initials || null;
      if (role !== undefined) {
        if (!["user", "admin"].includes(role)) {
          return res.status(400).json({ message: "Invalid role" });
        }
        if (actorId === userId && role !== "admin") {
          return res.status(400).json({ message: "You cannot demote yourself" });
        }
        updateFields.role = role;
        updateFields.isAdmin = role === "admin";
      }
      if (dashboardScope !== undefined) updateFields.dashboardScope = dashboardScope || "my_projects";
      if (dashboardLayout !== undefined) updateFields.dashboardLayout = dashboardLayout || "estimator";
      if (assignedRegion !== undefined) updateFields.assignedRegion = assignedRegion || null;
      if (email !== undefined) {
        const normalizedEmail = email.trim().toLowerCase();
        if (!isAllowedDomain(normalizedEmail)) {
          return res.status(400).json({ message: "Email domain is not in the allowed list" });
        }
        const [existing] = await db.select().from(users).where(eq(users.email, normalizedEmail));
        if (existing && existing.id !== userId) {
          return res.status(409).json({ message: "Another user already has this email" });
        }
        updateFields.email = normalizedEmail;
      }

      if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({ message: "No fields to update" });
      }

      const [updated] = await db
        .update(users)
        .set(updateFields)
        .where(eq(users.id, userId))
        .returning();

      if (!updated) return res.status(404).json({ message: "User not found" });

      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "user_profile_updated",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "user",
        entityId: String(userId),
        summary: `Updated profile of ${updated.email}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json(updated);
    } catch (error) {
      console.error("[Admin] Update profile error:", error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  });

  app.delete("/api/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params.id);
      const actorId = (req.session as any)?.userId;
      if (userId === actorId) {
        return res.status(400).json({ message: "You cannot delete yourself" });
      }
      const [target] = await db.select().from(users).where(eq(users.id, userId));
      if (!target) return res.status(404).json({ message: "User not found" });
      await db.execute(sql`DELETE FROM aps_tokens WHERE user_id = ${userId}`);
      await db.execute(sql`DELETE FROM proposal_acknowledgements WHERE user_id = ${userId}`);
      await db.execute(sql`DELETE FROM notifications WHERE user_id = ${userId}`);
      await db.execute(sql`UPDATE bc_sync_state SET synced_by = NULL WHERE synced_by = ${userId}`);
      await db.delete(userFeatureAccess).where(eq(userFeatureAccess.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "user_deleted",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "user",
        entityId: String(userId),
        summary: `Deleted user ${target.email}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });
      res.json({ success: true, deleted: target.email });
    } catch (error) {
      console.error("[Admin] Delete user error:", error);
      res.status(500).json({ message: "Failed to delete user" });
    }
  });

  app.post("/api/admin/cleanup/remove-inactive", requireAdmin, async (req: Request, res: Response) => {
    try {
      const actorId = (req.session as any)?.userId;
      const inactiveUsers = await db.select().from(users).where(
        and(eq(users.isActive, false), sql`${users.id} != ${actorId}`)
      );
      const deletedEmails: string[] = [];
      for (const u of inactiveUsers) {
        try {
          await db.delete(userFeatureAccess).where(eq(userFeatureAccess.userId, u.id));
          await db.delete(users).where(eq(users.id, u.id));
          deletedEmails.push(u.email);
        } catch (err: any) {
          console.error(`Failed to delete inactive user ${u.id}:`, err.message);
        }
      }
      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "cleanup_inactive_users",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "system",
        summary: `Deleted ${deletedEmails.length} inactive users: ${deletedEmails.join(", ")}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });
      res.json({ success: true, deleted: deletedEmails.length, emails: deletedEmails });
    } catch (error) {
      console.error("[Admin] Remove inactive users error:", error);
      res.status(500).json({ message: "Failed to remove inactive users" });
    }
  });

  app.get("/api/admin/audit", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { user: userFilter, from, to, action, search, limit: limitParam } = req.query;
      const limit = Math.min(parseInt(limitParam as string) || 100, 500);

      const conditions: any[] = [];

      if (userFilter) {
        conditions.push(like(auditLogs.actorEmail, `%${userFilter}%`));
      }
      if (from) {
        conditions.push(gte(auditLogs.timestamp, new Date(from as string)));
      }
      if (to) {
        const toDate = new Date(to as string);
        toDate.setHours(23, 59, 59, 999);
        conditions.push(lte(auditLogs.timestamp, toDate));
      }
      if (action) {
        conditions.push(eq(auditLogs.actionType, action as string));
      }
      if (search) {
        conditions.push(
          or(
            like(auditLogs.summary, `%${search}%`),
            like(auditLogs.actorEmail, `%${search}%`),
            like(auditLogs.requestPath, `%${search}%`)
          )
        );
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const logs = await db
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.timestamp))
        .limit(limit);

      res.json(logs);
    } catch (error) {
      console.error("[Admin] Audit log fetch error:", error);
      res.status(500).json({ message: "Failed to fetch audit logs" });
    }
  });

  app.get("/api/admin/audit/action-types", requireAdmin, async (req: Request, res: Response) => {
    try {
      const result = await db
        .selectDistinct({ actionType: auditLogs.actionType })
        .from(auditLogs)
        .orderBy(auditLogs.actionType);
      res.json(result.map(r => r.actionType));
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch action types" });
    }
  });

  // ---- USER PERMISSIONS ----

  // Get all users with their feature access
  app.get("/api/admin/users/permissions/matrix", requireAdmin, async (req: Request, res: Response) => {
    try {
      const allUsers = await db.select().from(users);
      
      const usersWithPermissions = await Promise.all(
        allUsers.map(async (user) => {
          const features = await storage.getUserFeatureAccess(user.id);
          return {
            ...user,
            features,
            availableFeatures: Object.values(FEATURES),
          };
        })
      );

      res.json(usersWithPermissions);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch permissions matrix" });
    }
  });

  // Update a user's feature access
  app.patch("/api/admin/users/:id/permissions", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params.id);
      const { features } = req.body as { features: Feature[] };
      const actorId = (req.session as any)?.userId;

      // Validate features
      const validFeatures = Object.values(FEATURES);
      if (!Array.isArray(features) || !features.every((f) => validFeatures.includes(f))) {
        return res.status(400).json({ message: "Invalid features provided" });
      }

      // Get user
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) return res.status(404).json({ message: "User not found" });

      // Update permissions
      await storage.setUserFeatureAccess(userId, features);

      // Audit log
      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "user_permissions_changed",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "user",
        entityId: String(userId),
        summary: `Updated permissions for ${user.email}: ${features.join(", ")}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      const updatedFeatures = await storage.getUserFeatureAccess(userId);
      res.json({ success: true, features: updatedFeatures });
    } catch (error) {
      res.status(500).json({ message: "Failed to update permissions" });
    }
  });

  // Reset user permissions to role defaults
  app.post("/api/admin/users/:id/reset-permissions", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params.id);
      const actorId = (req.session as any)?.userId;

      // Get user
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) return res.status(404).json({ message: "User not found" });

      // Get default features for the user's role
      const defaultFeatures = DEFAULT_ROLE_FEATURES[user.role] || DEFAULT_ROLE_FEATURES.user;

      // Set permissions to defaults
      await storage.setUserFeatureAccess(userId, defaultFeatures);

      // Audit log
      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "user_permissions_reset",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "user",
        entityId: String(userId),
        summary: `Reset permissions for ${user.email} to ${user.role} defaults`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json({ success: true, features: defaultFeatures });
    } catch (error) {
      res.status(500).json({ message: "Failed to reset permissions" });
    }
  });

  // Grant a single feature to a user
  app.post("/api/admin/users/:id/permissions/grant", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params.id);
      const { feature } = req.body as { feature: string };
      const validFeatures = Object.values(FEATURES);
      if (!feature || !validFeatures.includes(feature as any)) {
        return res.status(400).json({ message: "Invalid feature" });
      }
      const current = await storage.getUserFeatureAccess(userId);
      const next = Array.from(new Set([...current, feature])) as Feature[];
      await storage.setUserFeatureAccess(userId, next);
      res.json({ success: true, features: next });
    } catch (error) {
      res.status(500).json({ message: "Failed to grant permission" });
    }
  });

  // Revoke a single feature from a user
  app.post("/api/admin/users/:id/permissions/revoke", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params.id);
      const { feature } = req.body as { feature: string };
      const validFeatures = Object.values(FEATURES);
      if (!feature || !validFeatures.includes(feature as any)) {
        return res.status(400).json({ message: "Invalid feature" });
      }
      const current = await storage.getUserFeatureAccess(userId);
      const next = current.filter((f) => f !== feature);
      await storage.setUserFeatureAccess(userId, next);
      res.json({ success: true, features: next });
    } catch (error) {
      res.status(500).json({ message: "Failed to revoke permission" });
    }
  });

  // Get all available features
  app.get("/api/admin/features", requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(Object.values(FEATURES));
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch features" });
    }
  });

  // ---- PERMISSION PROFILES ----

  // Get all permission profiles
  app.get("/api/admin/profiles", requireAdmin, async (req: Request, res: Response) => {
    try {
      const profiles = await db.select().from(permissionProfiles).orderBy(desc(permissionProfiles.createdAt));
      res.json(profiles);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch profiles" });
    }
  });

  // Create a new permission profile
  app.post("/api/admin/profiles", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { name, description, features } = req.body as {
        name: string;
        description?: string;
        features: string[];
      };
      const actorId = (req.session as any)?.userId;

      if (!name || !Array.isArray(features)) {
        return res.status(400).json({ message: "Name and features are required" });
      }

      const [created] = await db
        .insert(permissionProfiles)
        .values({ name, description, features })
        .returning();

      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "profile_created",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "profile",
        entityId: String(created.id),
        summary: `Created permission profile "${name}" with ${features.length} features`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json(created);
    } catch (error: any) {
      if (error.message?.includes("unique")) {
        return res.status(400).json({ message: "Profile name already exists" });
      }
      res.status(500).json({ message: "Failed to create profile" });
    }
  });

  // Update a permission profile
  app.patch("/api/admin/profiles/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
      const profileId = parseInt(req.params.id);
      const { name, description, features } = req.body as {
        name?: string;
        description?: string;
        features?: string[];
      };
      const actorId = (req.session as any)?.userId;

      const [updated] = await db
        .update(permissionProfiles)
        .set({
          name: name || undefined,
          description: description || undefined,
          features: features || undefined,
          updatedAt: new Date(),
        })
        .where(eq(permissionProfiles.id, profileId))
        .returning();

      if (!updated) return res.status(404).json({ message: "Profile not found" });

      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "profile_updated",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "profile",
        entityId: String(profileId),
        summary: `Updated permission profile "${updated.name}"`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update profile" });
    }
  });

  // Delete a permission profile
  app.delete("/api/admin/profiles/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
      const profileId = parseInt(req.params.id);
      const actorId = (req.session as any)?.userId;

      const [deleted] = await db
        .delete(permissionProfiles)
        .where(eq(permissionProfiles.id, profileId))
        .returning();

      if (!deleted) return res.status(404).json({ message: "Profile not found" });

      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "profile_deleted",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "profile",
        entityId: String(profileId),
        summary: `Deleted permission profile "${deleted.name}"`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete profile" });
    }
  });

  // Assign a profile to a user (applies profile features as user's permissions)
  app.post("/api/admin/users/:userId/assign-profile/:profileId", requireAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params.userId);
      const profileId = parseInt(req.params.profileId);
      const actorId = (req.session as any)?.userId;

      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) return res.status(404).json({ message: "User not found" });

      const [profile] = await db.select().from(permissionProfiles).where(eq(permissionProfiles.id, profileId));
      if (!profile) return res.status(404).json({ message: "Profile not found" });

      // Apply profile features to user
      await storage.setUserFeatureAccess(userId, profile.features);

      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "profile_assigned",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "user",
        entityId: String(userId),
        summary: `Assigned profile "${profile.name}" to ${user.email}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json({ success: true, features: profile.features });
    } catch (error) {
      res.status(500).json({ message: "Failed to assign profile" });
    }
  });

  // ---- USER CLEANUP ----

  // Check for duplicate users (dry run - shows what would be deleted)
  app.get("/api/admin/cleanup/check-duplicates", requireAdmin, async (req: Request, res: Response) => {
    try {
      const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));
      const emailMap = new Map<string, typeof users.$inferSelect[]>();

      // Group users by email
      for (const user of allUsers) {
        const email = user.email.toLowerCase();
        if (!emailMap.has(email)) {
          emailMap.set(email, []);
        }
        emailMap.get(email)!.push(user);
      }

      // Find duplicates
      const duplicates = Array.from(emailMap.entries())
        .filter(([_, userList]) => userList.length > 1)
        .map(([email, userList]) => ({
          email,
          count: userList.length,
          keeper: {
            id: userList[userList.length - 1].id, // Last one (oldest by createdAt)
            createdAt: userList[userList.length - 1].createdAt,
            displayName: userList[userList.length - 1].displayName,
          },
          toDelete: userList.slice(0, -1).map((u) => ({
            id: u.id,
            createdAt: u.createdAt,
            displayName: u.displayName,
          })),
        }));

      res.json({
        duplicateCount: duplicates.length,
        totalUsersToDelete: duplicates.reduce((sum, d) => sum + d.toDelete.length, 0),
        duplicates,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to check for duplicates" });
    }
  });

  // Actually delete duplicate users
  app.post("/api/admin/cleanup/remove-duplicates", requireAdmin, async (req: Request, res: Response) => {
    try {
      const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));
      const emailMap = new Map<string, typeof users.$inferSelect[]>();

      // Group users by email
      for (const user of allUsers) {
        const email = user.email.toLowerCase();
        if (!emailMap.has(email)) {
          emailMap.set(email, []);
        }
        emailMap.get(email)!.push(user);
      }

      // Find and delete duplicates
      const actorId = (req.session as any)?.userId;
      const deletedIds: number[] = [];

      for (const [email, userList] of emailMap.entries()) {
        if (userList.length > 1) {
          // Keep the last one (oldest), delete the rest
          const toDelete = userList.slice(0, -1);

          for (const user of toDelete) {
            try {
              // Delete user feature access first
              await db.delete(userFeatureAccess).where(eq(userFeatureAccess.userId, user.id));
              // Then delete the user
              await db.delete(users).where(eq(users.id, user.id));
              deletedIds.push(user.id);
            } catch (err: any) {
              console.error(`Failed to delete duplicate user ${user.id}:`, err.message);
            }
          }
        }
      }

      // Audit log
      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "cleanup_duplicates",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "system",
        summary: `Removed ${deletedIds.length} duplicate users: ${deletedIds.join(", ")}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json({
        success: true,
        deletedCount: deletedIds.length,
        deletedIds,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to remove duplicates" });
    }
  });

  // Link a profile to a role
  app.patch("/api/admin/profiles/:id/link-role", requireAdmin, async (req: Request, res: Response) => {
    try {
      const profileId = parseInt(req.params.id);
      const { role } = req.body as { role?: string };
      const actorId = (req.session as any)?.userId;

      // If role is provided, check it's valid
      if (role && !["user", "admin", "accounting", "project_manager"].includes(role)) {
        return res.status(400).json({ message: "Invalid role" });
      }

      // If setting this profile to a role, unlink any other profiles from that role first
      if (role) {
        await db
          .update(permissionProfiles)
          .set({ linkedRole: null })
          .where(eq(permissionProfiles.linkedRole, role));
      }

      const [updated] = await db
        .update(permissionProfiles)
        .set({ linkedRole: role || null })
        .where(eq(permissionProfiles.id, profileId))
        .returning();

      if (!updated) return res.status(404).json({ message: "Profile not found" });

      const [actor] = await db.select().from(users).where(eq(users.id, actorId));
      await auditLog({
        actionType: "profile_role_linked",
        actorUserId: actorId,
        actorEmail: actor?.email,
        entityType: "profile",
        entityId: String(profileId),
        summary: `Linked profile "${updated.name}" to role ${role || "none"}`,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "",
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to link profile to role" });
    }
  });
}
