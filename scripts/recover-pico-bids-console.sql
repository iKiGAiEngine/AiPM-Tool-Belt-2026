WITH t AS (
  SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts
),
notes AS (
  SELECT
    t.ts || ': Recovery pico-2022-2023-recovery-2026-11-09: Restored 26-1870 / Loading Dock Equipment to unapproved BC draft review. Reversed erroneous Duplicate rejection and removed the erroneous bid-round addition from entry 2023. Estimate number, scope, region, due date and BC identity preserved.' AS n22,
    t.ts || ': Recovery pico-2022-2023-recovery-2026-11-09: Restored 26-1871 / Specialties to unapproved BC draft review. Reversed merge into entry 2022. Estimate number, scope, LAX - SPD region, due date and BC identity preserved.' AS n23
  FROM t
),
matching AS (
  SELECT p.id
  FROM public.proposal_log_entries p
  WHERE (
      p.id = 2022
      AND p.estimate_number = '26-1870'
      AND p.deleted_at = TIMESTAMP '2026-11-06 23:39:50.591'
      AND p.is_draft = false
      AND p.estimate_status = 'No Bid'
      AND p.duplicate_override_note IS NULL
      AND p.project_name = 'Pico & Beverwil Redevelopment'
      AND p.scope_list::jsonb = '["Loading Dock Equipment"]'::jsonb
      AND p.region = ''
      AND p.due_date = '2026-11-25'
      AND p.bc_project_id = ''
      AND p.bc_opportunity_ids::jsonb = '["6aecf214ca64225044039100"]'::jsonb
      AND p.project_db_id IS NULL
      AND p.draft_approved_by IS NULL
      AND p.draft_approved_at IS NULL
      AND p.pending_deletion = false
      AND p.bid_rounds = '[{"notes":"Merged from BC draft: Pico & Beverwil Redevelopment","addedAt":"2026-11-06T23:39:33.389Z","addedBy":"Gonzalo Martinez","dueDate":"2026-11-25","roundNumber":1}]'::jsonb
      AND p.bc_change_log::jsonb = '["2026-11-06T23:39:50.591Z: Rejected by Gonzalo Martinez - Duplicate"]'::jsonb
    ) OR (
      p.id = 2023
      AND p.estimate_number = '26-1871'
      AND p.deleted_at = TIMESTAMP '2026-11-06 23:39:33.412'
      AND p.is_draft = false
      AND p.estimate_status = 'Draft'
      AND p.duplicate_override_note = 'Merged into entry #2022 as bid round by Gonzalo Martinez'
      AND p.project_name = 'Pico & Beverwil Redevelopment'
      AND p.scope_list::jsonb = '["Specialties"]'::jsonb
      AND p.region = 'LAX - SPD'
      AND p.due_date = '2026-11-25'
      AND p.bc_project_id = ''
      AND p.bc_opportunity_ids::jsonb = '["6ae911df5ca661923aaf9828"]'::jsonb
      AND p.project_db_id IS NULL
      AND p.draft_approved_by IS NULL
      AND p.draft_approved_at IS NULL
      AND p.pending_deletion = false
      AND p.bid_rounds = '[]'::jsonb
      AND p.bc_change_log IS NULL
    )
),
upd AS (
  UPDATE public.proposal_log_entries p
  SET
    is_draft = true,
    deleted_at = NULL,
    estimate_status = CASE WHEN p.id = 2022 THEN 'Draft' ELSE p.estimate_status END,
    bid_rounds = CASE WHEN p.id = 2022 THEN '[]'::jsonb ELSE p.bid_rounds END,
    duplicate_override_note = CASE WHEN p.id = 2023 THEN NULL ELSE p.duplicate_override_note END,
    bc_change_log = (
      COALESCE(p.bc_change_log::jsonb, '[]'::jsonb)
      || jsonb_build_array(CASE WHEN p.id = 2022 THEN (SELECT n22 FROM notes) ELSE (SELECT n23 FROM notes) END)
    )::text
  WHERE p.id IN (2022, 2023)
    AND (SELECT count(*) FROM matching) = 2
    AND NOT EXISTS (
      SELECT 1 FROM public.proposal_log_entries o
      WHERE o.estimate_number IN ('26-1870', '26-1871') AND o.id NOT IN (2022, 2023)
    )
    AND (
      SELECT count(*) FROM public.bc_sync_log s
      WHERE (s.bc_opportunity_id = '6aecf214ca64225044039100' AND s.entry_id = 2022)
         OR (s.bc_opportunity_id = '6ae911df5ca661923aaf9828' AND s.entry_id = 2023)
    ) = 2
  RETURNING p.id
)
INSERT INTO public.audit_logs (timestamp, action_type, entity_type, entity_id, summary, metadata)
SELECT
  clock_timestamp() AT TIME ZONE 'UTC',
  'bc_draft_recovered',
  'bc_invite',
  u.id::text,
  CASE WHEN u.id = 2022 THEN n.n22 ELSE n.n23 END,
  jsonb_build_object(
    'recovery_key', 'pico-2022-2023-recovery-2026-11-09',
    'execution_method', 'manual production SQL console',
    'reason', 'Reverse merge-then-duplicate-rejection incident'
  )
FROM upd u CROSS JOIN notes n;
