// One-off migration: merge each project's "Plans" and "Specs" folders into a
// single "Plans and Specs" folder.
//
// Background: plans and specs used to live in two separate folders under
// "Estimate Folder/Bid Documents". They now share one combined folder. New
// projects get the combined folder automatically; this script converts the
// projects already on disk.
//
// Safety:
//   - Moves entries, never deletes them. A legacy folder is removed only after
//     it is completely empty.
//   - If a name already exists in the destination, the entry is LEFT IN PLACE
//     and reported, so nothing is ever silently overwritten.
//   - Idempotent: running it twice is harmless.
//
// The app reads plans/specs from the combined folder and falls back to the old
// folders, so projects keep working whether or not this has been run.
//
// Run from the project root. Always dry-run first:
//   tsx scripts/merge-plans-specs-folders.ts --dry-run
//   tsx scripts/merge-plans-specs-folders.ts

import fs from "fs";
import path from "path";

const PROJECTS_DIR = path.join(process.cwd(), "projects");
const BID_DOCS = path.join("Estimate Folder", "Bid Documents");
const COMBINED = "Plans and Specs";
const LEGACY = ["Plans", "Specs"];

function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(`No projects directory found at ${PROJECTS_DIR}. Run this from the project root.`);
    process.exit(1);
  }

  const projects = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  console.log(`${dryRun ? "[dry-run] " : ""}Merging "Plans" + "Specs" into "${COMBINED}" across ${projects.length} project(s)...\n`);

  let moved = 0;
  let foldersRemoved = 0;
  let projectsTouched = 0;
  const conflicts: string[] = [];
  const failures: string[] = [];

  for (const project of projects) {
    const bidDocs = path.join(PROJECTS_DIR, project, BID_DOCS);
    if (!fs.existsSync(bidDocs)) continue;

    const legacyPresent = LEGACY.filter((name) => fs.existsSync(path.join(bidDocs, name)));
    if (legacyPresent.length === 0) continue;

    projectsTouched++;
    const destination = path.join(bidDocs, COMBINED);
    if (!dryRun) fs.mkdirSync(destination, { recursive: true });

    for (const legacyName of legacyPresent) {
      const legacyDir = path.join(bidDocs, legacyName);
      let entries: string[];
      try {
        entries = fs.readdirSync(legacyDir);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`FAILED to read ${project}/${BID_DOCS}/${legacyName} — ${message}`);
        failures.push(project);
        continue;
      }

      for (const entry of entries) {
        const from = path.join(legacyDir, entry);
        const to = path.join(destination, entry);

        if (fs.existsSync(to)) {
          console.warn(`CONFLICT (left in place): ${project} — "${legacyName}/${entry}" already exists in "${COMBINED}"`);
          conflicts.push(`${project}: ${legacyName}/${entry}`);
          continue;
        }

        if (dryRun) {
          console.log(`[dry-run] would move: ${project} — ${legacyName}/${entry} -> ${COMBINED}/${entry}`);
          moved++;
          continue;
        }

        try {
          fs.renameSync(from, to);
          console.log(`moved: ${project} — ${legacyName}/${entry} -> ${COMBINED}/${entry}`);
          moved++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`FAILED to move ${project}/${legacyName}/${entry} — ${message}`);
          failures.push(project);
        }
      }

      // Remove the legacy folder only when nothing is left inside it.
      const remaining = dryRun
        ? entries.filter((e) => fs.existsSync(path.join(destination, e))).length
        : fs.readdirSync(legacyDir).length;

      if (remaining === 0) {
        if (dryRun) {
          console.log(`[dry-run] would remove empty folder: ${project} — ${legacyName}`);
        } else {
          try {
            fs.rmdirSync(legacyDir);
            console.log(`removed empty folder: ${project} — ${legacyName}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`FAILED to remove ${project}/${legacyName} — ${message}`);
            failures.push(project);
            continue;
          }
        }
        foldersRemoved++;
      } else {
        console.warn(`kept "${legacyName}" in ${project} — ${remaining} item(s) still inside`);
      }
    }
  }

  console.log(
    `\n${dryRun ? "[dry-run] " : ""}Done. ${projectsTouched} project(s) had legacy folders: ` +
      `${moved} item(s) ${dryRun ? "to move" : "moved"}, ${foldersRemoved} empty folder(s) ${dryRun ? "to remove" : "removed"}, ` +
      `${conflicts.length} conflict(s), ${failures.length} failure(s).`,
  );

  if (conflicts.length > 0) {
    console.warn(`\nConflicts left untouched — move these by hand:\n  ${conflicts.join("\n  ")}`);
  }
  if (failures.length > 0) {
    console.error(`\nProjects with failures: ${[...new Set(failures)].join(", ")}`);
    process.exit(1);
  }
}

main();
