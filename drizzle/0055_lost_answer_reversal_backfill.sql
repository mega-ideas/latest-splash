-- Lost-answer reversals, backfill (v2 Phase 2 §4.5, review of cda0fa7).
-- Before cda0fa7, when the partner's answer to an instruction was lost the
-- service reversed it once by the intent id and, if that one reversal was
-- not taken, cancelled the payout with failure 'partner_error', no
-- partner_ref and return_asks 0. The sweep (reversalsOwedForStaff) now asks
-- again for a cancelled row with no reference only when return_asks > 0, so
-- those rows were never asked again. This counts that one ask on them, from
-- the instruction_reversed event it left, so the sweep reverses them by the
-- intent id until the partner takes it.
--
-- Only rows in exactly that state are touched: cancelled, failure
-- 'partner_error', no reference, nothing counted and nothing accepted, with
-- an instruction_reversed event that was not taken and none that was. A row
-- whose reversal was taken owes nothing and is left alone. Running it again
-- changes nothing (return_asks is then 1). The append-only event trail is
-- only read.

UPDATE "withdrawals" AS w
SET "return_asks" = 1,
    "return_asked_at" = (
      SELECT max(e."created_at") FROM "withdrawal_events" AS e
      WHERE e."org_id" = w."org_id" AND e."subject" = 'withdrawal' AND e."subject_id" = w."id" AND e."action" = 'instruction_reversed'
    ),
    "updated_at" = now()
WHERE w."status" = 'cancelled'
  AND w."failure" = 'partner_error'
  AND w."partner_ref" IS NULL
  AND w."return_asks" = 0
  AND w."return_accepted_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "withdrawal_events" AS e
    WHERE e."org_id" = w."org_id" AND e."subject" = 'withdrawal' AND e."subject_id" = w."id"
      AND e."action" = 'instruction_reversed' AND e."detail"->>'accepted' = 'false'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "withdrawal_events" AS e
    WHERE e."org_id" = w."org_id" AND e."subject" = 'withdrawal' AND e."subject_id" = w."id"
      AND e."action" = 'instruction_reversed' AND e."detail"->>'accepted' = 'true'
  );
