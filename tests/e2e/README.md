# End-to-end tests

Playwright e2e specs for this app.

## Running

The tests need credentials for a test admin user, the test admin's
user id, and a Postgres connection string. None of these are
hardcoded — pass them via the environment.

```bash
DATABASE_URL=postgres://...           \
E2E_ADMIN_EMAIL=...                   \
E2E_ADMIN_PASSWORD=...                \
E2E_ADMIN_USER_ID=...                 \
E2E_BASE_URL=http://localhost:5000    \  # optional, defaults to localhost:5000
E2E_PROPOSAL_LOG_ID=368               \  # optional, defaults to 368
npx playwright test
```

The dev server (`npm run dev`) must be running on `E2E_BASE_URL`.

## Specs

- `vendor-tags-rfq.spec.ts` — verifies that vendor scope and
  manufacturer tags edited in the Vendor Database UI persist to the
  database and correctly include/exclude vendors in the RFQ recipient
  picker on the Estimating Module.
- `types-quantities.spec.ts` — verifies the "T&Q Rec'd" checkbox on the
  Proposal Log persists server-side, that the lead-time day count never
  leaks into the log grid, that ticks land in the Proposal Change Log,
  and that the T&Q Lead Time Report renders every report type and
  exports CSV.

## Unit tests

Pure logic is covered by plain `node:assert` scripts run under `tsx`
(no test runner, no database):

```bash
npm run test:unit
```

`server/swinertonOffices.test.ts` transitively imports `server/db.ts`, so
it needs a `DATABASE_URL` in the environment and is run separately:

```bash
DATABASE_URL=postgres://... npm run test:unit:db
```
