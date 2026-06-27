import type { Express, Request, Response, NextFunction } from "express";
import { db } from "./db";
import { users, DEFAULT_ROLE_FEATURES, userFeatureAccess } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { randomBytes, createHash } from "crypto";
import bcrypt from "bcrypt";
import { auditLog } from "./auditService";
import { storage } from "./storage";
import { sendPasswordResetEmail } from "./emailService";

const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || "nationalbuildingspecialties.com,swinerton.com")
  .split(",")
  .map(d => d.trim().toLowerCase());

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(key: string, max: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}

export function isAllowedDomain(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return ALLOWED_DOMAINS.includes(domain);
}

function getClientIP(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

export function registerAuthRoutes(app: Express) {
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const ip = getClientIP(req);

      if (!checkRateLimit(`login:${ip}`, 10) || !checkRateLimit(`login:${normalizedEmail}`, 10)) {
        return res.status(429).json({ message: "Too many login attempts. Please try again later." });
      }

      const [user] = await db.select().from(users).where(sql`LOWER(${users.email}) = ${normalizedEmail}`);

      if (!user || !user.passwordHash || user.status !== "active" || !user.isActive) {
        await auditLog({
          actionType: "login_failed",
          actorEmail: normalizedEmail,
          summary: "Failed login attempt",
          ipAddress: ip,
          userAgent: req.headers["user-agent"] || "",
          requestPath: req.path,
          requestMethod: req.method,
        });
        return res.status(401).json({ message: "Invalid email or password" });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        await auditLog({
          actionType: "login_failed",
          actorEmail: normalizedEmail,
          summary: "Failed login attempt (wrong password)",
          ipAddress: ip,
          userAgent: req.headers["user-agent"] || "",
          requestPath: req.path,
          requestMethod: req.method,
        });
        return res.status(401).json({ message: "Invalid email or password" });
      }

      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

      const existingPermissions = await storage.getUserFeatureAccess(user.id);
      if (existingPermissions.length === 0) {
        const defaultFeatures = DEFAULT_ROLE_FEATURES[user.role] || DEFAULT_ROLE_FEATURES.user;
        if (defaultFeatures.length > 0) {
          await db.insert(userFeatureAccess).values(
            defaultFeatures.map((feature) => ({ userId: user.id, feature }))
          );
        }
      }

      (req.session as any).userId = user.id;

      await auditLog({
        actionType: "login_success",
        actorUserId: user.id,
        actorEmail: user.email,
        summary: "User logged in",
        ipAddress: ip,
        userAgent: req.headers["user-agent"] || "",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json({
        user: { id: user.id, email: user.email, role: user.role, initials: user.initials, displayName: user.displayName, username: user.username, dashboardScope: user.dashboardScope, dashboardLayout: user.dashboardLayout, assignedRegion: user.assignedRegion, mustChangePassword: user.mustChangePassword },
      });
    } catch (error: any) {
      console.error("[Auth] Login error:", error);
      res.status(500).json({ message: "Login failed" });
    }
  });

  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({ message: "Email is required" });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const ip = getClientIP(req);

      const rateLimitPassed = checkRateLimit(`forgot:${ip}`, 5);

      if (rateLimitPassed) {
        const [user] = await db.select().from(users).where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
        if (user && user.status === "active" && user.isActive) {
          const { raw, hash } = generateToken();
          const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
          await db.update(users).set({ resetToken: hash, resetTokenExpiresAt: expiresAt }).where(eq(users.id, user.id));
          try {
            await sendPasswordResetEmail(normalizedEmail, raw);
          } catch (emailErr: any) {
            console.error("[Auth] Failed to send password reset email:", emailErr.message);
          }
        }
      } else {
        console.warn(`[Auth] Forgot-password rate limit exceeded for IP ${ip}`);
      }

      res.json({ message: "If that email is registered and active, you will receive a password reset link." });
    } catch (error: any) {
      console.error("[Auth] Forgot password error:", error);
      res.json({ message: "If that email is registered and active, you will receive a password reset link." });
    }
  });

  app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
    try {
      const { token, password } = req.body;
      if (!token || !password) {
        return res.status(400).json({ message: "Token and password are required" });
      }

      if (password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }

      const tokenHash = hashToken(token);
      const now = new Date();
      const [user] = await db.select().from(users).where(eq(users.resetToken, tokenHash));

      if (!user || !user.resetTokenExpiresAt || user.resetTokenExpiresAt < now) {
        return res.status(400).json({ message: "This link has expired or is invalid. Please request a new one." });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      await db.update(users).set({
        passwordHash,
        resetToken: null,
        resetTokenExpiresAt: null,
        status: "active",
        isActive: true,
      }).where(eq(users.id, user.id));

      await auditLog({
        actionType: "password_reset",
        actorUserId: user.id,
        actorEmail: user.email,
        summary: "Password was reset via reset link",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json({ message: "Password has been set successfully. You may now sign in." });
    } catch (error: any) {
      console.error("[Auth] Reset password error:", error);
      res.status(500).json({ message: "Failed to reset password" });
    }
  });

  app.post("/api/auth/change-password", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current and new passwords are required" });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({ message: "New password must be at least 8 characters" });
      }

      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user || !user.isActive || user.status !== "active") {
        (req.session as any).userId = null;
        return res.status(401).json({ message: "Authentication required" });
      }
      if (!user.passwordHash) {
        return res.status(400).json({ message: "No password set on this account" });
      }

      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }

      const hash = await bcrypt.hash(newPassword, 12);
      await db.update(users).set({ passwordHash: hash, mustChangePassword: false }).where(eq(users.id, user.id));

      await auditLog({
        actionType: "password_changed",
        actorUserId: user.id,
        actorEmail: user.email,
        summary: "User changed their password",
        requestPath: req.path,
        requestMethod: req.method,
      });

      res.json({ message: "Password changed successfully" });
    } catch (error: any) {
      console.error("[Auth] Change password error:", error);
      res.status(500).json({ message: "Failed to change password" });
    }
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) {
        return res.json({ user: null });
      }

      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user || !user.isActive) {
        (req.session as any).userId = null;
        return res.json({ user: null });
      }

      res.json({ user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName, initials: user.initials, username: user.username, dashboardScope: user.dashboardScope, dashboardLayout: user.dashboardLayout, assignedRegion: user.assignedRegion, mustChangePassword: user.mustChangePassword, is_admin: user.isAdmin === true } });
    } catch (error) {
      res.status(500).json({ message: "Failed to get user info" });
    }
  });

  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (userId) {
        const [user] = await db.select().from(users).where(eq(users.id, userId));
        await auditLog({
          actionType: "logout",
          actorUserId: userId,
          actorEmail: user?.email,
          summary: "User logged out",
          ipAddress: getClientIP(req),
          userAgent: req.headers["user-agent"] || "",
          requestPath: req.path,
          requestMethod: req.method,
        });
      }

      req.session.destroy((err) => {
        if (err) console.error("[Auth] Session destroy error:", err);
        res.clearCookie("connect.sid");
        res.json({ message: "Logged out" });
      });
    } catch (error) {
      res.status(500).json({ message: "Logout failed" });
    }
  });
}

export async function requireWriteAccess(req: Request, res: Response, next: NextFunction) {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    return res.status(401).json({ message: "Authentication required" });
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || !user.isActive) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: "Account is deactivated" });
  }
  if (user.role === "viewer" || user.email?.toLowerCase() === "viewonly@aipm.local") {
    return res.status(403).json({ error: "READ_ONLY", message: "This account is read-only and cannot make changes." });
  }
  next();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    return res.status(401).json({ message: "Authentication required" });
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || !user.isActive) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: "Account is deactivated" });
  }
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    return res.status(401).json({ message: "Authentication required" });
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || !user.isActive) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: "Account is deactivated" });
  }
  if (user.role !== "admin" && !user.isAdmin) {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
}

export function requireAdminOrFeature(feature: string) {
  return async function (req: Request, res: Response, next: NextFunction) {
    const userId = (req.session as any)?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Authentication required" });
    }
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || !user.isActive) {
      req.session.destroy(() => {});
      return res.status(401).json({ message: "Account is deactivated" });
    }
    if (user.role === "admin" || user.isAdmin) return next();
    const { storage } = await import("./storage");
    const features = await storage.getUserFeatureAccess(user.id);
    if (!features.includes(feature as any)) {
      return res.status(403).json({ message: "Access denied" });
    }
    next();
  };
}
