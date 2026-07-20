// Standalone AiPM QA Audit runner.
//
// Runs the full audit and prints a human-readable report. Exits non-zero when
// the verdict is RED (or YELLOW with --strict), so it can gate CI / cron.
//
// Usage:
//   # Audit the live site over HTTP only (no DB) — ideal for CI / external cron:
//   QA_AUDIT_BASE_URL=https://app.example.com tsx scripts/qa-audit.ts
//
//   # Full local audit (HTTP + database + config), co-located with the app:
//   DATABASE_URL=postgres://... QA_AUDIT_BASE_URL=http://localhost:5000 \
//     tsx scripts/qa-audit.ts
//
// Flags / env:
//   --base <url> | QA_AUDIT_BASE_URL   base URL to probe
//   --strict     | QA_AUDIT_STRICT=1   treat YELLOW as failure too
//   --json       | QA_AUDIT_JSON=1     print JSON instead of Markdown
//   --out <dir>  | QA_AUDIT_OUT        write report.json + report.html + report.md
//   --local                            force-enable DB/config checks
//   --no-local                         force HTTP-only

import fs from "fs";
import path from "path";
import { runAudit } from "../server/qaAudit/runner";
import { renderMarkdown, renderHtmlDocument } from "../server/qaAudit/report";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const baseUrl = arg("base") || process.env.QA_AUDIT_BASE_URL || undefined;
  const strict = flag("strict") || process.env.QA_AUDIT_STRICT === "1";
  const asJson = flag("json") || process.env.QA_AUDIT_JSON === "1";
  const outDir = arg("out") || process.env.QA_AUDIT_OUT || undefined;

  let includeLocalChecks: boolean | undefined;
  if (flag("local")) includeLocalChecks = true;
  if (flag("no-local")) includeLocalChecks = false;

  if (!baseUrl && includeLocalChecks !== true) {
    console.error("No target given. Set QA_AUDIT_BASE_URL or pass --base <url> (or --local for in-process only).");
    process.exit(2);
  }

  const report = await runAudit({
    baseUrl,
    includeLocalChecks,
    persist: false, // CLI persistence is opt-in via the server; keep CLI side-effect-free
  });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMarkdown(report));
  }

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outDir, "report.md"), renderMarkdown(report));
    fs.writeFileSync(path.join(outDir, "report.html"), renderHtmlDocument(report));
    console.error(`\nReports written to ${outDir}/report.{json,md,html}`);
  }

  const failed = report.status === "RED" || (strict && report.status === "YELLOW");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("QA audit crashed:", err?.stack || err?.message || err);
  process.exit(3);
});
