import { db } from "./db";
import { sql } from "drizzle-orm";

export async function repairProjectIdSequence(): Promise<void> {
  const dupeCheck = await db.execute(sql`
    SELECT year, COUNT(*) as cnt FROM project_id_sequence GROUP BY year HAVING COUNT(*) > 1
  `);

  if (dupeCheck.rows.length === 0) return;

  console.log("[DataRepair] Found duplicate project_id_sequence rows, repairing...");

  for (const row of dupeCheck.rows) {
    const year = (row as any).year;

    await db.execute(sql`
      DELETE FROM project_id_sequence
      WHERE year = ${year}
        AND id NOT IN (
          SELECT id FROM project_id_sequence
          WHERE year = ${year}
          ORDER BY last_sequence DESC
          LIMIT 1
        )
    `);
  }

  console.log("[DataRepair] Deduplicated project_id_sequence rows");
}

export async function repairDuplicateEstimateNumbers(): Promise<void> {
  const dupes = await db.execute(sql`
    SELECT estimate_number, COUNT(*) as cnt
    FROM proposal_log_entries
    GROUP BY estimate_number
    HAVING COUNT(*) > 1
  `);

  if (dupes.rows.length === 0) return;

  console.log("[DataRepair] Found duplicate estimate numbers, reassigning...");

  const allEntries = await db.execute(sql`
    SELECT id, estimate_number, project_db_id
    FROM proposal_log_entries
    ORDER BY id ASC
  `);

  const currentYear = new Date().getFullYear() % 100;

  const seqRow = await db.execute(sql`
    SELECT last_sequence FROM project_id_sequence WHERE year = ${currentYear}
  `);
  let nextSeq = seqRow.rows.length > 0 ? ((seqRow.rows[0] as any).last_sequence as number) : 0;

  const usedNumbers = new Set<string>();
  const reassignments: { id: number; oldNum: string; newNum: string; projectDbId: number | null }[] = [];

  for (const entry of allEntries.rows as any[]) {
    const num = entry.estimate_number as string;
    if (!usedNumbers.has(num)) {
      usedNumbers.add(num);
      continue;
    }

    nextSeq++;
    const yearStr = currentYear.toString().padStart(2, "0");
    const newNum = `${yearStr}-${nextSeq.toString().padStart(4, "0")}`;
    usedNumbers.add(newNum);

    reassignments.push({
      id: entry.id,
      oldNum: num,
      newNum,
      projectDbId: entry.project_db_id,
    });
  }

  for (const r of reassignments) {
    await db.execute(sql`
      UPDATE proposal_log_entries SET estimate_number = ${r.newNum} WHERE id = ${r.id}
    `);

    if (r.projectDbId) {
      await db.execute(sql`
        UPDATE projects SET project_id = ${r.newNum} WHERE id = ${r.projectDbId}
      `);
    }

    console.log(`[DataRepair] Reassigned entry ${r.id}: ${r.oldNum} -> ${r.newNum}`);
  }

  await db.execute(sql`
    INSERT INTO project_id_sequence (year, last_sequence)
    VALUES (${currentYear}, ${nextSeq})
    ON CONFLICT (year) DO UPDATE SET last_sequence = ${nextSeq}
  `);

  console.log(`[DataRepair] Updated sequence counter to ${nextSeq}`);
}

export async function repairProposalStatuses(): Promise<void> {
  const result = await db.execute(sql`
    UPDATE proposal_log_entries
    SET estimate_status = 'Submitted'
    WHERE estimate_status = 'Estimating'
      AND proposal_total IS NOT NULL
      AND proposal_total != ''
      AND proposal_total != '0'
      AND REGEXP_REPLACE(proposal_total, '[^0-9.]', '', 'g') ~ '^\d+\.?\d*$'
      AND CAST(REGEXP_REPLACE(proposal_total, '[^0-9.]', '', 'g') AS NUMERIC) > 0
      AND deleted_at IS NULL
    RETURNING id, estimate_number
  `);

  if (result.rows.length > 0) {
    console.log(`[DataRepair] Fixed ${result.rows.length} proposal entries: had proposalTotal but status was still "Estimating" -> "Submitted"`);
    for (const row of result.rows) {
      console.log(`[DataRepair]   Entry id=${(row as any).id} estNum=${(row as any).estimate_number}`);
    }
  }
}

// One-time fix: assign Welbe Health - TESTING (26-1257) to the VO (ViewOnly) account
// so it appears in the ViewOnly user's Home HUD. Safe to leave in — idempotent.
export async function assignWelbeTestingToViewOnly(): Promise<void> {
  const result = await db.execute(sql`
    UPDATE proposal_log_entries
    SET nbs_estimator = 'VO'
    WHERE estimate_number = '26-1257'
      AND (nbs_estimator IS DISTINCT FROM 'VO')
    RETURNING id, project_name, estimate_number, nbs_estimator
  `);
  if (result.rows.length > 0) {
    const row = result.rows[0] as any;
    console.log(`[DataRepair] Assigned "${row.project_name}" (${row.estimate_number}) nbs_estimator -> VO`);
  }
}

export async function runDataRepairs(): Promise<void> {
  try {
    await repairProjectIdSequence();
    await repairDuplicateEstimateNumbers();
    await repairProposalStatuses();
    await assignWelbeTestingToViewOnly();
  } catch (err) {
    console.error("[DataRepair] Error during data repair:", err);
  }
}
