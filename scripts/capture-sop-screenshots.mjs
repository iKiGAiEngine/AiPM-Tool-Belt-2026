import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.SHOT_BASE || "http://localhost:5000";
const EMAIL = process.env.SHOT_EMAIL || "test-admin@aipmapp.com";
const PASSWORD = process.env.SHOT_PASSWORD || "NBS4130";
const OUT = resolve("attached_assets/sop-screenshots");

mkdirSync(OUT, { recursive: true });

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="input-email"]', { timeout: 15_000 });
  await page.fill('[data-testid="input-email"]', EMAIL);
  await page.fill('[data-testid="input-password"]', PASSWORD);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.click('[data-testid="button-sign-in"]'),
  ]);
  await page.waitForTimeout(1500);
}

async function shot(page, path, name, opts = {}) {
  console.log(`  → ${name}  (${path})`);
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(opts.delay ?? 1500);
  if (opts.waitFor) {
    try {
      await page.waitForSelector(opts.waitFor, { timeout: 8_000 });
    } catch {
      console.log(`     (warn) selector ${opts.waitFor} not found`);
    }
  }
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    fullPage: opts.fullPage ?? true,
  });
}

const targets = [
  { path: "/", name: "01-home-page", waitFor: '[data-testid="tile-helpcenter"], .tool-card' },
  { path: "/help-center", name: "02-help-center-hub", waitFor: '[data-testid="text-helpcenter-title"]' },
  { path: "/help-center/bc-sync", name: "03-help-center-bc-sync" },
  { path: "/help-center/proposal-log", name: "04-help-center-proposal-log" },
  { path: "/help-center/estimating-module", name: "05-help-center-estimating" },
  { path: "/tools/proposal-log", name: "10-proposal-log-dashboard", delay: 3000 },
  { path: "/tools/bc-sync-table", name: "11-bc-sync-table-admin", delay: 2500 },
  { path: "/project-start", name: "20-project-start" },
  { path: "/spec-extractor", name: "30-spec-extractor" },
  { path: "/schedule-converter", name: "40-schedule-converter" },
  { path: "/admin/permissions", name: "90-admin-permissions" },
];

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  console.log("Logging in...");
  await login(page);
  console.log(`Logged in. Capturing ${targets.length} screenshots → ${OUT}`);

  for (const t of targets) {
    try {
      await shot(page, t.path, t.name, { waitFor: t.waitFor, delay: t.delay });
    } catch (err) {
      console.log(`     (fail) ${t.name}: ${err.message}`);
    }
  }

  await browser.close();
  console.log("Done.");
})();
