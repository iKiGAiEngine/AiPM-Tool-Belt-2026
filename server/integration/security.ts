// ══════════════════════════════════════════════════════════════════════════
// INTEGRATION API — AUTHENTICATION, CORS, RATE LIMITING
// ══════════════════════════════════════════════════════════════════════════
//
// The rest of AiPM authenticates with a login session cookie. Power Automate
// cannot hold a session cookie, so this API authenticates with a long-lived
// API key instead, and is mounted BEFORE the session middleware in
// server/routes.ts so no cookie is ever required or read here.
//
// Because that bypasses the app's normal login, everything in this file is
// deliberately strict: keys are compared in constant time, every key carries
// an explicit permission, every call is rate limited, and every write is
// written to the audit log with the key's label attached.

import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export type ApiKeyPermission = "read" | "write";

export interface IntegrationApiKey {
  /** Human name for the caller, e.g. "power-automate". Shows up in audit logs. */
  label: string;
  /** "read" can only GET. "write" can also POST/PUT/PATCH/DELETE. */
  permission: ApiKeyPermission;
  /** sha256 of the secret — the plaintext is never retained. */
  digest: Buffer;
}

declare global {
  namespace Express {
    interface Request {
      integrationKey?: IntegrationApiKey;
    }
  }
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();

/**
 * Parse the configured keys.
 *
 * AIPM_INTEGRATION_API_KEY      — a single secret, full read/write access.
 * AIPM_INTEGRATION_API_KEYS     — comma separated, each entry one of:
 *                                   <secret>                     (write)
 *                                   <label>:<secret>             (write)
 *                                   <label>:read:<secret>        (read only)
 *                                   <label>:write:<secret>       (read/write)
 *
 * Secrets must be at least 24 characters. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
 */
export function loadApiKeys(env: NodeJS.ProcessEnv = process.env): IntegrationApiKey[] {
  const keys: IntegrationApiKey[] = [];
  const raw = [env.AIPM_INTEGRATION_API_KEY, env.AIPM_INTEGRATION_API_KEYS]
    .filter(Boolean)
    .join(",");

  for (const entry of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    const parts = entry.split(":").map(s => s.trim());
    let label = "default";
    let permission: ApiKeyPermission = "write";
    let secret: string;

    if (parts.length >= 3 && (parts[1] === "read" || parts[1] === "write")) {
      label = parts[0];
      permission = parts[1] as ApiKeyPermission;
      secret = parts.slice(2).join(":");
    } else if (parts.length === 2) {
      label = parts[0];
      secret = parts[1];
    } else {
      secret = entry;
    }

    if (!secret || secret.length < 24) {
      console.warn(`[IntegrationAPI] Ignoring key "${label}" — secret must be at least 24 characters.`);
      continue;
    }
    keys.push({ label, permission, digest: sha256(secret) });
  }
  return keys;
}

let cachedKeys: IntegrationApiKey[] | null = null;
function apiKeys(): IntegrationApiKey[] {
  if (cachedKeys === null) {
    cachedKeys = loadApiKeys();
    if (cachedKeys.length === 0) {
      console.warn(
        "[IntegrationAPI] No API keys configured — /api/integration/v1 will reject every request. " +
        "Set AIPM_INTEGRATION_API_KEY to enable it."
      );
    } else {
      console.log(`[IntegrationAPI] ${cachedKeys.length} API key(s) loaded: ${cachedKeys.map(k => `${k.label}(${k.permission})`).join(", ")}`);
    }
  }
  return cachedKeys;
}

/** Test seam — forget the cached keys so a new env is picked up. */
export function resetApiKeyCache(): void {
  cachedKeys = null;
}

/** Pull the presented secret out of `X-API-Key` or `Authorization: Bearer`. */
export function presentedSecret(req: Request): string | null {
  const header = req.header("x-api-key");
  if (header && header.trim()) return header.trim();
  const auth = req.header("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return null;
}

function matchKey(secret: string): IntegrationApiKey | null {
  const presented = sha256(secret);
  // Compare against every configured key rather than breaking early, so the
  // time taken does not reveal how many keys exist or which one matched.
  let found: IntegrationApiKey | null = null;
  for (const key of apiKeys()) {
    if (crypto.timingSafeEqual(presented, key.digest)) found = key;
  }
  return found;
}

// ── Rate limiting ──────────────────────────────────────────────────────────
// A plain fixed-window counter per key. Power Automate flows are chatty on a
// schedule, not bursty, so this only exists to stop a runaway loop from
// hammering the database.

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.AIPM_INTEGRATION_RATE_LIMIT || 300);
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(label: string): { limited: boolean; retryAfter: number } {
  const now = Date.now();
  const bucket = buckets.get(label);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(label, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { limited: false, retryAfter: 0 };
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    return { limited: true, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { limited: false, retryAfter: 0 };
}

// ── CORS ───────────────────────────────────────────────────────────────────
//
// Power Automate cloud flows call from Microsoft's servers, where CORS does
// not apply. CORS matters for the browser-side callers: a custom connector's
// test pane, Copilot Studio, and any Power App embedding this data.
//
// Set AIPM_INTEGRATION_CORS_ORIGINS to a comma separated allow-list to lock
// this down; it defaults to "*". Credentials are never allowed — this API
// authenticates by header, never by cookie, so a wildcard origin cannot be
// used to ride someone's AiPM login.

const ALLOWED_ORIGINS = (process.env.AIPM_INTEGRATION_CORS_ORIGINS || "*")
  .split(",").map(s => s.trim()).filter(Boolean);

export function integrationCors(req: Request, res: Response, next: NextFunction) {
  const origin = req.header("origin");
  if (ALLOWED_ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-API-Key,Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

// ── Error envelope ─────────────────────────────────────────────────────────
//
// Every failure from this API looks the same, so a Power Automate flow can
// branch on `body.error.code` instead of parsing prose.

export function apiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown
) {
  return res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

// ── Authentication ─────────────────────────────────────────────────────────

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const secret = presentedSecret(req);
  if (!secret) {
    res.setHeader("WWW-Authenticate", 'ApiKey realm="AiPM Integration API"');
    return apiError(res, 401, "MISSING_API_KEY",
      "Provide your API key in the X-API-Key header (or as an Authorization: Bearer token).");
  }

  const key = matchKey(secret);
  if (!key) {
    return apiError(res, 401, "INVALID_API_KEY", "The API key presented is not recognized.");
  }

  const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (isWrite && key.permission !== "write") {
    return apiError(res, 403, "READ_ONLY_KEY",
      `API key "${key.label}" is read-only and cannot ${req.method} to this API.`);
  }

  const { limited, retryAfter } = rateLimited(key.label);
  if (limited) {
    res.setHeader("Retry-After", String(retryAfter));
    return apiError(res, 429, "RATE_LIMITED",
      `Rate limit of ${RATE_LIMIT_MAX} requests/minute exceeded for key "${key.label}". Retry in ${retryAfter}s.`);
  }

  req.integrationKey = key;
  next();
}
