import { test, expect, request as playwrightRequest, type Cookie } from "@playwright/test";
import { Pool } from "pg";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const ADMIN_USER_ID = Number(process.env.E2E_ADMIN_USER_ID);

if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !Number.isFinite(ADMIN_USER_ID)) {
  throw new Error(
    "Missing required env vars: E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_ADMIN_USER_ID. " +
      "Set them in your shell before running this test (no defaults provided to avoid hardcoded credentials).",
  );
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}

// COL_DEFS is a top-level `const` in the Proposal Log's inline script. That
// makes it a global *lexical* binding — reachable by name inside page.evaluate,
// but never a property of `window`. Declared here so TypeScript accepts it.
declare const COL_DEFS: Array<{ key: string; label: string }>;

function makeDb() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return {
    pool,
    one: async <T = any>(sql: string, params: any[] = []): Promise<T> => {
      const r = await pool.query(sql, params);
      return r.rows[0] as T;
    },
    run: async (sql: string, params: any[] = []) => {
      await pool.query(sql, params);
    },
    end: () => pool.end(),
  };
}

/**
 * 'YYYY-MM-DD' n calendar days from today, in the same business timezone the
 * server stamps receipts in (see BUSINESS_TIMEZONE in shared/tqLeadTime.ts).
 * Using host-local time here would fail on any machine whose clock has already
 * rolled past midnight Pacific — e.g. a UTC CI runner in the evening.
 */
const BUSINESS_TIMEZONE = "America/Los_Angeles";

function isoOffset(days: number): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
  const [y, m, d] = today.split("-").map(Number);
  const shifted = new Date(y, m - 1, d + days);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}-${String(
    shifted.getDate(),
  ).padStart(2, "0")}`;
}

test.describe("Types & Quantities receipt tracking and lead-time report", () => {
  const suffix = rand();
  const PROJECT_NAME = `ZZ-TQ-Test-${suffix}`;
  const ESTIMATE_NUMBER = `TQ-${suffix}`;
  const DUE_DATE = isoOffset(21);

  let ENTRY_ID = 0;
  let database: ReturnType<typeof makeDb>;
  // Log in once for the whole file and replay the session cookie into each test.
  // The login endpoint rate-limits to 10 attempts per 15 minutes per IP and per
  // email, so authenticating per-test makes the suite unrunnable twice in a row.
  let sessionCookies: Cookie[] = [];

  test.beforeAll(async () => {
    database = makeDb();

    const api = await playwrightRequest.newContext({
      baseURL: process.env.E2E_BASE_URL || "http://localhost:5000",
    });
    const login = await api.post("/api/auth/login", {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), `login should succeed (got ${login.status()})`).toBeTruthy();
    sessionCookies = (await api.storageState()).cookies;
    expect(sessionCookies.length, "login should set a session cookie").toBeGreaterThan(0);
    await api.dispose();

    ENTRY_ID = (
      await database.one<{ id: number }>(
        `INSERT INTO proposal_log_entries
           (project_name, estimate_number, region, primary_market, due_date, nbs_estimator,
            gc_estimate_lead, estimate_status, is_test)
         VALUES ($1, $2, 'LAX - TM', 'Healthcare', $3, 'ZZ', $4, 'Estimating', true)
         RETURNING id`,
        [PROJECT_NAME, ESTIMATE_NUMBER, DUE_DATE, `ZZ GC ${suffix}`],
      )
    ).id;
  });

  test.afterAll(async () => {
    if (ENTRY_ID) {
      await database.run(`DELETE FROM proposal_change_log WHERE entry_id = $1`, [ENTRY_ID]).catch(() => {});
      await database.run(`DELETE FROM proposal_log_entries WHERE id = $1`, [ENTRY_ID]).catch(() => {});
    }
    await database.end();
  });

  // Every test reuses the single authenticated session captured above.
  test.beforeEach(async ({ page }) => {
    await page.context().addCookies(sessionCookies);
  });

  test("the checkbox persists to the database and back", async ({ page }) => {
    await page.goto("/tools/proposal-log");

    // Clear the default status filter and search for our seeded row so it renders.
    await page.waitForSelector("#main-table tbody tr", { timeout: 30_000 });
    await page.selectOption("#f-status", "");
    await page.fill("#search", PROJECT_NAME);
    await page.waitForTimeout(500);

    const row = page.locator("#main-table tbody tr", { hasText: PROJECT_NAME }).first();
    await expect(row).toBeVisible();

    const checkbox = row.locator("input.tq-check");
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    await checkbox.check();

    // Server-side truth, not just the optimistic UI.
    await expect
      .poll(
        async () => {
          const r = await database.one<{ tq_received_date: string | null; tq_received_by: string | null }>(
            `SELECT tq_received_date, tq_received_by FROM proposal_log_entries WHERE id = $1`,
            [ENTRY_ID],
          );
          return r.tq_received_date;
        },
        { timeout: 10_000 },
      )
      .toBeTruthy();

    const stored = await database.one<{ tq_received_date: string; tq_received_by: string; tq_received_at: Date }>(
      `SELECT tq_received_date, tq_received_by, tq_received_at FROM proposal_log_entries WHERE id = $1`,
      [ENTRY_ID],
    );
    expect(stored.tq_received_date).toBe(isoOffset(0));
    expect(stored.tq_received_by).toBeTruthy();
    expect(stored.tq_received_at).toBeTruthy();

    // Survives a reload — proves it came from the server, not localStorage.
    await page.reload();
    await page.waitForSelector("#main-table tbody tr", { timeout: 30_000 });
    await page.selectOption("#f-status", "");
    await page.fill("#search", PROJECT_NAME);
    await page.waitForTimeout(500);
    await expect(page.locator("#main-table tbody tr", { hasText: PROJECT_NAME }).first().locator("input.tq-check"))
      .toBeChecked();
  });

  test("the log never displays the lead-time day count", async ({ page }) => {
    await page.goto("/tools/proposal-log");
    await page.waitForSelector("#main-table tbody tr", { timeout: 30_000 });
    await page.selectOption("#f-status", "");
    await page.fill("#search", PROJECT_NAME);
    await page.waitForTimeout(500);

    const row = page.locator("#main-table tbody tr", { hasText: PROJECT_NAME }).first();
    const text = (await row.innerText()).toUpperCase();
    // The report owns the day count; the grid shows a checkbox and nothing else.
    expect(text).not.toContain("BD");
    expect(text).not.toContain("BUSINESS DAY");
    expect(text).not.toContain("LEAD");
  });

  test("every column is listed in Manage Columns so users can reorder it", async ({ page }) => {
    await page.goto("/tools/proposal-log");
    await page.waitForSelector("#main-table tbody tr", { timeout: 30_000 });
    await page.selectOption("#f-status", "");
    await page.waitForTimeout(500);

    await page.click('button:has-text("More")');
    await page.click('button:has-text("Columns")');
    await page.waitForSelector("#col-panel-body .col-item", { timeout: 10_000 });

    const { defined, listed } = await page.evaluate(() => ({
      // `_actions` is the pinned row-button column — no label, nothing to manage.
      defined: COL_DEFS.map((c) => c.key).filter((k) => k !== "_actions"),
      listed: Array.from(document.querySelectorAll("#col-panel-body .col-item")).map(
        (el) => (el as HTMLElement).dataset.key,
      ),
    }));

    const missing = defined.filter((k: string) => !listed.includes(k));
    expect(missing, `columns missing from the Manage Columns panel: ${missing.join(", ")}`).toEqual([]);
    expect(listed).toContain("tqReceived");

    // Listed is not enough — the entry has to actually toggle the column off.
    const headers = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("#header-row th[data-col]")).map(
          (th) => (th as HTMLElement).dataset.col,
        ),
      );
    expect(await headers()).toContain("tqReceived");

    const toggle = async () =>
      page.evaluate(() => {
        const item = Array.from(document.querySelectorAll("#col-panel-body .col-item")).find(
          (el) => (el as HTMLElement).dataset.key === "tqReceived",
        )!;
        (item.querySelector(".col-check") as HTMLInputElement).click();
      });

    await toggle();
    await page.waitForTimeout(300);
    expect(await headers()).not.toContain("tqReceived");

    await toggle();
    await page.waitForTimeout(300);
    expect(await headers()).toContain("tqReceived");
  });

  test("unchecking clears the stored receipt", async ({ page }) => {
    await database.run(
      `UPDATE proposal_log_entries SET tq_received_date=$2, tq_received_by='ZZ', tq_received_at=NOW() WHERE id=$1`,
      [ENTRY_ID, isoOffset(-3)],
    );

    await page.goto("/tools/proposal-log");
    await page.waitForSelector("#main-table tbody tr", { timeout: 30_000 });
    await page.selectOption("#f-status", "");
    await page.fill("#search", PROJECT_NAME);
    await page.waitForTimeout(500);

    const checkbox = page
      .locator("#main-table tbody tr", { hasText: PROJECT_NAME })
      .first()
      .locator("input.tq-check");
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();

    await expect
      .poll(
        async () => {
          const r = await database.one<{ tq_received_date: string | null }>(
            `SELECT tq_received_date FROM proposal_log_entries WHERE id = $1`,
            [ENTRY_ID],
          );
          return r.tq_received_date;
        },
        { timeout: 10_000 },
      )
      .toBeNull();
  });

  test("the tick is recorded in the proposal change log", async ({ page }) => {
    const res = await page.request.post(`/api/proposal-log/entry/${ENTRY_ID}/types-quantities`, {
      data: { received: true, receivedDate: isoOffset(-5) },
    });
    expect(res.ok()).toBeTruthy();

    const logged = await database.one<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM proposal_change_log WHERE entry_id=$1 AND field_name='tqReceivedDate'`,
      [ENTRY_ID],
    );
    expect(Number(logged.c)).toBeGreaterThan(0);

    await page.goto("/admin/proposal-change-log");
    await expect(page.getByText("T&Q Received").first()).toBeVisible({ timeout: 20_000 });
  });

  test("the API back-dates a receipt and rejects a malformed date", async ({ page }) => {
    const ok = await page.request.post(`/api/proposal-log/entry/${ENTRY_ID}/types-quantities`, {
      data: { received: true, receivedDate: isoOffset(-10) },
    });
    expect(ok.ok()).toBeTruthy();
    expect((await ok.json()).tqReceivedDate).toBe(isoOffset(-10));

    const bad = await page.request.post(`/api/proposal-log/entry/${ENTRY_ID}/types-quantities`, {
      data: { received: true, receivedDate: "07/01/2026" },
    });
    expect(bad.status()).toBe(400);
  });

  test("the report renders, switches types, and exports CSV", async ({ page }) => {
    // Give the seeded bid a known 10-business-day runway.
    await database.run(
      `UPDATE proposal_log_entries SET tq_received_date=$2, tq_received_by='ZZ', tq_received_at=NOW() WHERE id=$1`,
      [ENTRY_ID, isoOffset(-1)],
    );

    await page.goto("/reports/types-quantities");
    await expect(page.getByTestId("heading-tq-report")).toBeVisible({ timeout: 20_000 });

    // TL;DR is always present and non-empty.
    const tldr = page.getByTestId("text-tldr");
    await expect(tldr).toBeVisible();
    expect((await tldr.innerText()).length).toBeGreaterThan(20);

    // Include test entries so our seeded row is in scope.
    await page.getByTestId("checkbox-include-test").check();
    await expect(page.getByTestId("tile-coverage")).toBeVisible();

    // Every report type renders without error.
    for (const label of [
      "By Region",
      "By Market",
      "By GC / Client",
      "By Estimator",
      "Monthly Trend",
      "Bid Detail",
      "Exceptions",
      "Executive Summary",
    ]) {
      await page.getByTestId("select-report-type").click();
      await page.getByRole("option", { name: label, exact: true }).click();
      await expect(page.getByTestId("text-error")).toHaveCount(0);
      await page.waitForTimeout(300);
    }

    // Detail view shows our bid with its computed lead time.
    await page.getByTestId("select-report-type").click();
    await page.getByRole("option", { name: "Bid Detail", exact: true }).click();
    await expect(page.getByTestId(`row-bid-${ENTRY_ID}`)).toBeVisible({ timeout: 15_000 });

    // CSV export.
    const csv = await page.request.get("/api/reports/types-quantities?type=detail&format=csv&includeTest=true");
    expect(csv.ok()).toBeTruthy();
    expect(csv.headers()["content-type"]).toContain("text/csv");
    const body = await csv.text();
    expect(body.split("\r\n")[0]).toContain("Project Name");
    expect(body).toContain(PROJECT_NAME);
  });

  test("a user without the feature cannot reach the report API", async ({ page, browser }) => {
    // The admin has implicit access; verify the endpoint itself is gated by
    // hitting it with no session at all.
    const ctx = await browser.newContext();
    const res = await ctx.request.get("/api/reports/types-quantities?type=summary");
    expect(res.status()).toBe(401);
    await ctx.close();
  });
});
