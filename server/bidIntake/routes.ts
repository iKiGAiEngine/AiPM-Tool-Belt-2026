import type { Express, Request, Response } from "express";
import { desc, inArray } from "drizzle-orm";
import { db } from "../db";
import { apsTokens, auditLogs, bcSyncLog, bcSyncState, users } from "@shared/schema";
import { getActiveProposalLogEntries } from "../proposalLogService";
import { getValidToken } from "../autodesk/tokenManager";
import { fetchBcOpportunities, filterByGcAllowlist } from "../autodesk/bcSync";
import {
  buildPendingDrafts,
  buildWorkload,
  countUnpulledInvites,
  todayInZone,
} from "./workload";

// Same zone BuildingConnected uses to display due dates (see bcSync.ts).
const TIME_ZONE = "America/Los_Angeles";

// How often we are willing to talk to BuildingConnected. Reading the home page
// never calls BC directly - it reads the saved result below. A new BC check
// only starts when the saved result is older than BC_STALE_MS (and someone is
// looking), or when someone presses "Refresh from BC" (at most once a minute).
const BC_STALE_MS = 15 * 60 * 1000;
const BC_MANUAL_COOLDOWN_MS = 60 * 1000;

// Audit-log actions written when someone processes a BC invite.
const PROCESSED_ACTIONS = [
  "bc_draft_accepted",
  "bc_draft_merged",
  "bc_draft_rejected",
  "bc_draft_rejected_duplicate",
];

type BcStatus = "never_checked" | "ok" | "not_connected" | "error";

interface BcSnapshot {
  status: BcStatus;
  checkedAt: Date | null;
  waitingInBc: number | null;
  message: string | null;
  inFlight: Promise<void> | null;
}

// Lives in memory: it simply resets (and re-checks) when the server restarts.
const bc: BcSnapshot = {
  status: "never_checked",
  checkedAt: null,
  waitingInBc: null,
  message: null,
  inFlight: null,
};

/** Prefer the viewer's own BC connection; otherwise borrow the newest working one. */
async function findBcToken(preferUserId: number | undefined): Promise<string | null> {
  if (preferUserId) {
    const own = await getValidToken(preferUserId);
    if (own) return own;
  }
  const candidates = await db
    .select({ userId: apsTokens.userId })
    .from(apsTokens)
    .orderBy(desc(apsTokens.updatedAt))
    .limit(3);
  for (const c of candidates) {
    if (c.userId === preferUserId) continue;
    const t = await getValidToken(c.userId);
    if (t) return t;
  }
  return null;
}

async function checkBc(preferUserId: number | undefined): Promise<void> {
  try {
    const token = await findBcToken(preferUserId);
    if (!token) {
      bc.status = "not_connected";
      bc.message = "BuildingConnected isn't connected. Someone with BC access needs to connect it once.";
      bc.waitingInBc = null;
      bc.checkedAt = new Date();
      return;
    }

    // Same window the real "Pull" uses, so this number matches what Gonzalo would see.
    const [syncState] = await db.select().from(bcSyncState).limit(1);
    const since = syncState?.lastSyncAt
      ? new Date(syncState.lastSyncAt)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const isFirstSync = !syncState?.lastSyncAt;

    const { opportunities, error } = await fetchBcOpportunities(token, since, isFirstSync);
    if (error) {
      bc.status = "error";
      bc.message = error;
      bc.checkedAt = new Date();
      return;
    }

    const logged = new Set(
      (await db.select({ id: bcSyncLog.bcOpportunityId }).from(bcSyncLog)).map((r) => r.id),
    );
    bc.waitingInBc = countUnpulledInvites(filterByGcAllowlist(opportunities), logged);
    bc.status = "ok";
    bc.message = null;
    bc.checkedAt = new Date();
  } catch (err: any) {
    console.error("[Bid Intake] BC check failed:", err);
    bc.status = "error";
    bc.message = "Couldn't reach BuildingConnected.";
    bc.checkedAt = new Date();
  }
}

/** Starts a BC check unless one is already running (one at a time, ever). */
function startBcCheck(preferUserId: number | undefined): Promise<void> {
  if (!bc.inFlight) {
    bc.inFlight = checkBc(preferUserId).finally(() => { bc.inFlight = null; });
  }
  return bc.inFlight;
}

async function buildSummary(now: Date) {
  const today = todayInZone(now, TIME_ZONE);
  const [entries, userRows, processed] = await Promise.all([
    getActiveProposalLogEntries(),
    db.select({
      displayName: users.displayName, email: users.email,
      initials: users.initials, isActive: users.isActive,
    }).from(users),
    db.select({ timestamp: auditLogs.timestamp, actor: auditLogs.actorEmail })
      .from(auditLogs)
      .where(inArray(auditLogs.actionType, PROCESSED_ACTIONS))
      .orderBy(desc(auditLogs.timestamp))
      .limit(1),
  ]);

  const drafts = buildPendingDrafts(entries as any, today, now, 8);
  const workload = buildWorkload(entries as any, userRows, today, now);

  return {
    generatedAt: now.toISOString(),
    pendingDrafts: drafts.count,
    oldestWaitingHours: drafts.oldestWaitingHours,
    drafts: drafts.items,
    lastProcessedAt: processed[0]?.timestamp?.toISOString() ?? null,
    lastProcessedBy: processed[0]?.actor ?? null,
    workload,
    bc: {
      status: bc.status,
      checkedAt: bc.checkedAt?.toISOString() ?? null,
      waitingInBc: bc.waitingInBc,
      message: bc.message,
      checking: !!bc.inFlight,
    },
  };
}

export function registerBidIntakeRoutes(app: Express) {
  // Read-only, like the Proposal Log entries list (any signed-in user).
  app.get("/api/bid-intake/summary", async (req: Request, res: Response) => {
    try {
      const userId: number | undefined = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });

      const stale = !bc.checkedAt || Date.now() - bc.checkedAt.getTime() > BC_STALE_MS;
      if (stale && !bc.inFlight) void startBcCheck(userId);

      res.json(await buildSummary(new Date()));
    } catch (err) {
      console.error("[Bid Intake] Summary error:", err);
      res.status(500).json({ message: "Failed to load bid intake summary" });
    }
  });

  // "Refresh from BC" button. Waits for the check so the answer is fresh.
  app.post("/api/bid-intake/refresh", async (req: Request, res: Response) => {
    try {
      const userId: number | undefined = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });

      const recentlyChecked = bc.checkedAt && Date.now() - bc.checkedAt.getTime() < BC_MANUAL_COOLDOWN_MS;
      if (!recentlyChecked) await startBcCheck(userId);
      else if (bc.inFlight) await bc.inFlight;

      res.json(await buildSummary(new Date()));
    } catch (err) {
      console.error("[Bid Intake] Refresh error:", err);
      res.status(500).json({ message: "Failed to refresh from BuildingConnected" });
    }
  });
}
