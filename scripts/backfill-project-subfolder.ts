// One-off backfill: add a subfolder to every project folder already on disk.
//
// Background: the standard bid-folder structure comes from the "0000_Standard
// Folders" zip uploaded in AiPM Settings. That zip is only unpacked when a
// project is CREATED, so uploading a new version of it does NOT reach projects
// that already exist. This script closes that gap.
//
// It only ever creates directories -- it never renames, moves or deletes
// anything -- and it is idempotent, so running it twice is harmless.
//
// Run from the project root. Defaults to the folder named below:
//   tsx scripts/backfill-project-subfolder.ts
//
// Add --dry-run to list what it WOULD create without touching the disk:
//   tsx scripts/backfill-project-subfolder.ts --dry-run
//
// Pass a different subfolder path to reuse this for a future folder addition
// (forward slashes, relative to each project's root):
//   tsx scripts/backfill-project-subfolder.ts "Estimate Folder/Vendors/Quotes"

import fs from "fs";
import path from "path";

const PROJECTS_DIR = path.join(process.cwd(), "projects");
const DEFAULT_SUBFOLDER = "Estimate Folder/Bid Documents/BC Downloads";

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const requested = args.find((a) => !a.startsWith("--")) ?? DEFAULT_SUBFOLDER;

  // Normalize to the host OS separator so this works on Windows too.
  const subfolder = path.join(...requested.split("/").filter(Boolean));

  if (!subfolder || requested.includes("..") || path.isAbsolute(requested)) {
    console.error(`Refusing to use "${requested}" — pass a relative path inside a project folder.`);
    process.exit(1);
  }

  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(`No projects directory found at ${PROJECTS_DIR}. Run this from the project root.`);
    process.exit(1);
  }

  const projectDirs = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  console.log(`${dryRun ? "[dry-run] " : ""}Adding "${requested}" to ${projectDirs.length} project folder(s)...\n`);

  let created = 0;
  let alreadyPresent = 0;
  const failures: string[] = [];

  for (const projectName of projectDirs) {
    const target = path.join(PROJECTS_DIR, projectName, subfolder);

    if (fs.existsSync(target)) {
      alreadyPresent++;
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] would create: ${projectName}/${requested}`);
      created++;
      continue;
    }

    try {
      fs.mkdirSync(target, { recursive: true });
      console.log(`created: ${projectName}/${requested}`);
      created++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`FAILED: ${projectName} — ${message}`);
      failures.push(projectName);
    }
  }

  console.log(
    `\n${dryRun ? "[dry-run] " : ""}Scanned ${projectDirs.length} project folder(s): ` +
      `${created} ${dryRun ? "to create" : "created"}, ${alreadyPresent} already had it, ${failures.length} failed.`,
  );

  if (failures.length > 0) {
    console.error(`Projects that failed: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main();
