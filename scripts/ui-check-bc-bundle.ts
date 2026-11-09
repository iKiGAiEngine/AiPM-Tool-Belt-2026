// Visual/behaviour check of the BC Invites tab in a real browser, wired to the REAL endpoints and a
// scratch Postgres. Run: DATABASE_URL=postgres://tester:pw@localhost:5432/bctest npx tsx scripts/ui-check-bc-bundle.ts <screenshotDir>
import express from "express";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { db, pool } from "../server/db";
import { users, proposalLogEntries, bcSyncLog } from "@shared/schema";
import { registerBcSyncRoutes } from "../server/autodesk/bcSync";

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")) { console.error("scratch DB only"); process.exit(1); }
const shots = process.argv[2] || ".";

async function main() {
  await db.execute("TRUNCATE proposal_log_entries, bc_sync_log, audit_logs, users RESTART IDENTITY CASCADE" as any);
  const [admin] = await db.insert(users).values({ email: "a@test.dev", displayName: "Tester", role: "admin", isActive: true, status: "active" } as any).returning();
  const base = { projectName: "Pico & Beverwil Redevelopment", projectAddress: "9600 West Pico Boulevard, Los Angeles, CA 90035", dueDate: "2026-11-25", isDraft: true, sourceType: "bc", gcEstimateLead: "William Nutting", owner: "Swinerton Builders" };
  const [a] = await db.insert(proposalLogEntries).values({ ...base, estimateNumber: "26-1870", scopeList: JSON.stringify(["Loading Dock Equipment"]), bcOpportunityIds: JSON.stringify(["6aecf214ca64225044039100"]), region: "" } as any).returning();
  const [b] = await db.insert(proposalLogEntries).values({ ...base, estimateNumber: "26-1871", scopeList: JSON.stringify(["Specialties"]), bcOpportunityIds: JSON.stringify(["6ae911df5ca661923aaf9828"]), region: "LAX - SPD" } as any).returning();
  // an unrelated single invite, and a "possibly same" pair
  await db.insert(proposalLogEntries).values({ ...base, projectName: "Kaiser Medical Office Tower", projectAddress: "1 Main St, Oakland, CA", estimateNumber: "26-1880", scopeList: JSON.stringify(["Toilet Accessories"]), bcOpportunityIds: JSON.stringify(["k1"]), region: "SF" } as any);
  await db.insert(proposalLogEntries).values({ ...base, projectName: "Westfield Garage Expansion", projectAddress: "5 Mall Dr, San Jose, CA", estimateNumber: "26-1890", scopeList: JSON.stringify(["Lockers"]), bcOpportunityIds: JSON.stringify(["w1"]), region: "SJ" } as any);
  await db.insert(proposalLogEntries).values({ ...base, projectName: "Westfield Garage Expansion", projectAddress: "900 Other Rd, Fresno, CA", estimateNumber: "26-1891", scopeList: JSON.stringify(["Wall Protection"]), bcOpportunityIds: JSON.stringify(["w2"]), region: "FR" } as any);
  // a project that is ALREADY approved in the log, with a new invite arriving for another scope
  await db.insert(proposalLogEntries).values({ ...base, projectName: "Harbor Hospital Tower", projectAddress: "77 Bay St, Long Beach, CA", isDraft: false, estimateStatus: "Estimating", estimateNumber: "26-1500", scopeList: JSON.stringify(["Lockers"]), bcOpportunityIds: JSON.stringify(["h1"]), region: "LAX" } as any);
  await db.insert(proposalLogEntries).values({ ...base, projectName: "Harbor Hospital Tower", projectAddress: "77 Bay St, Long Beach, CA", estimateNumber: "26-1901", scopeList: JSON.stringify(["Toilet Accessories"]), bcOpportunityIds: JSON.stringify(["h2"]), region: "LAX" } as any);
  await db.insert(bcSyncLog).values([{ bcOpportunityId: "6aecf214ca64225044039100", entryId: a.id, rawData: {} }, { bcOpportunityId: "6ae911df5ca661923aaf9828", entryId: b.id, rawData: {} }] as any);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).session = { userId: admin.id }; next(); });
  app.get("/api/auth/me", (_q, r) => r.json({ user: { id: admin.id, email: admin.email, role: "admin", displayName: "Tester" } }));
  app.get("/api/user/features", (_q, r) => r.json([]));
  app.get("/api/proposal-log/all-entries", async (_q, r) => r.json(await db.select().from(proposalLogEntries)));
  registerBcSyncRoutes(app);
  app.use("/api", (_q, r) => r.json([]));
  app.use(express.static(path.join(process.cwd(), "public")));
  const server = http.createServer(app).listen(0);
  const port = (server.address() as any).port;

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("dialog", async (d) => { console.log("DIALOG:", d.message().replace(/\n/g, " | ")); await d.accept(); });
  await page.goto(`http://127.0.0.1:${port}/tools/proposal-log.html`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as any).setTab("newbids"));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/1-before.png`, fullPage: true });
  await page.screenshot({ path: `${shots}/1b-before-viewport.png`, clip: { x: 0, y: 100, width: 1280, height: 640 } });
  console.log("cards before:", await page.locator(".bc-invite-card").count(), "| group cards:", await page.locator(".bc-group-card").count());

  await page.locator(".bc-group-card", { hasText: "Loading Dock" }).getByRole("button", { name: "Combine into one bid" }).click();
  await page.waitForTimeout(1500);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/2-after-combine.png`, fullPage: true });
  console.log("cards after combine:", await page.locator(".bc-invite-card").count(), "| group cards:", await page.locator(".bc-group-card").count());
  const picoText = await page.locator(".bc-invite-card", { hasText: "Specialties" }).first().innerText();
  console.log("Pico card mentions both scopes:", picoText.includes("Loading Dock Equipment") && picoText.includes("Specialties"), "| shows combined note:", picoText.includes("combined into this one bid"));
  console.log("old buttons present (should be false):", await page.getByText("Merge", { exact: true }).count() > 0, await page.getByText("Duplicate", { exact: true }).count() > 0);
  await browser.close(); server.close(); await pool.end();
}
main().catch(async (e) => { console.error("FAILED:", e); try { await pool.end(); } catch {} process.exit(1); });
