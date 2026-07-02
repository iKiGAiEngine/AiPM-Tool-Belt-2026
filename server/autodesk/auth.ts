import type { Express, Request, Response } from "express";
import { db } from "../db";
import { apsTokens } from "@shared/schema";
import { eq } from "drizzle-orm";
import { requireAuth } from "../authRoutes";
import { hasValidConnection } from "./tokenManager";
import { randomBytes } from "crypto";

const APS_AUTH_BASE = "https://developer.api.autodesk.com/authentication/v2";
const APS_TOKEN_URL = `${APS_AUTH_BASE}/token`;
const STATE_TTL_MS = 10 * 60 * 1000;

function getRedirectUri(req?: Request): string {
  const hostHeader = req?.get("host");
  if (hostHeader) {
    const proto = (req?.get("x-forwarded-proto") || req?.protocol || "https").split(",")[0].trim();
    return `${proto}://${hostHeader}/auth/autodesk/callback`;
  }

  const raw = process.env.APS_REDIRECT_DOMAIN || process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS || "";
  const domain = raw.split(",")[0].trim();
  return `https://${domain}/auth/autodesk/callback`;
}

export function registerAutodeskRoutes(app: Express) {
  const envClientId = process.env.APS_CLIENT_ID;
  const envClientSecret = process.env.APS_CLIENT_SECRET;
  if (!envClientId || !envClientSecret) {
    console.warn("[APS] APS_CLIENT_ID / APS_CLIENT_SECRET not configured — BuildingConnected OAuth routes disabled");
  }

  app.get("/api/autodesk/login", requireAuth, (req: Request, res: Response) => {
    if (!envClientId) {
      return res.redirect("/tools/bc-sync-table?bc=error");
    }

    const userId = (req.session as any)?.userId;
    if (!userId) {
      return res.redirect("/tools/bc-sync-table?bc=error");
    }

    const nonce = randomBytes(32).toString("hex");

    (req.session as any).apsOAuthState = {
      nonce,
      userId,
      createdAt: Date.now(),
    };

    const redirectUri = getRedirectUri(req);
    const scope = "data:read";

    const authUrl = new URL(`${APS_AUTH_BASE}/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", envClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("state", nonce);

    res.redirect(authUrl.toString());
  });

  app.get("/auth/autodesk/callback", async (req: Request, res: Response) => {
    try {
      const { code, state, error } = req.query;

      if (error) {
        console.error("[APS] OAuth error:", error);
        return res.redirect("/tools/bc-sync-table?bc=error");
      }

      if (!code || !state) {
        return res.redirect("/tools/bc-sync-table?bc=error");
      }

      const nonce = state as string;
      const oauthState = (req.session as any)?.apsOAuthState;

      if (!oauthState || oauthState.nonce !== nonce) {
        console.error("[APS] Invalid or mismatched OAuth state");
        return res.redirect("/tools/bc-sync-table?bc=error");
      }

      if (Date.now() - oauthState.createdAt > STATE_TTL_MS) {
        delete (req.session as any).apsOAuthState;
        console.error("[APS] OAuth state expired");
        return res.redirect("/tools/bc-sync-table?bc=error");
      }

      const userId = oauthState.userId;
      delete (req.session as any).apsOAuthState;

      const clientId = process.env.APS_CLIENT_ID;
      const clientSecret = process.env.APS_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        console.error("[APS] Missing client credentials");
        return res.redirect("/tools/bc-sync-table?bc=error");
      }

      const redirectUri = getRedirectUri(req);

      const tokenRes = await fetch(APS_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error("[APS] Token exchange failed:", tokenRes.status, errText);
        return res.redirect("/tools/bc-sync-table?bc=error");
      }

      const data = await tokenRes.json() as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        scope?: string;
      };

      const expiresAt = new Date(Date.now() + data.expires_in * 1000);

      const [existing] = await db
        .select()
        .from(apsTokens)
        .where(eq(apsTokens.userId, userId));

      if (existing) {
        await db
          .update(apsTokens)
          .set({
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt,
            scope: data.scope || null,
            updatedAt: new Date(),
          })
          .where(eq(apsTokens.id, existing.id));
      } else {
        await db.insert(apsTokens).values({
          userId,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt,
          scope: data.scope || null,
        });
      }

      console.log(`[APS] User ${userId} connected to BuildingConnected`);
      res.redirect("/tools/bc-sync-table?bc=connected");
    } catch (err) {
      console.error("[APS] Callback error:", err);
      res.redirect("/tools/bc-sync-table?bc=error");
    }
  });

  app.get("/api/autodesk/status", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) {
        return res.json({ connected: false });
      }

      const connected = await hasValidConnection(userId);
      res.json({ connected });
    } catch (err) {
      console.error("[APS] Status check error:", err);
      res.json({ connected: false });
    }
  });

  app.post("/api/autodesk/disconnect", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) {
        return res.status(401).json({ message: "Authentication required" });
      }

      await db.delete(apsTokens).where(eq(apsTokens.userId, userId));
      res.json({ success: true });
    } catch (err) {
      console.error("[APS] Disconnect error:", err);
      res.status(500).json({ message: "Failed to disconnect" });
    }
  });
}
