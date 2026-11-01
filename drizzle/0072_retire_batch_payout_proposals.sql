-- Close the payout-run proposals (kind BATCH_PAYOUT) that are still open.
--
-- Zeke used to draft a "batch payout" proposal through a model tool. The v1
-- custody route that carried an approved one out is gone (docs/v2/phase3-batch.md),
-- so approving one only ever recorded "not executed", and a sheet now goes to the
-- wallet batch flow (wallet_batches), which the owners sign once. v2 Phase 3 removes
-- the kind from the code (docs/v2/phase3-zeke-batches.md), so a draft of that
-- kind still waiting in a queue would be a row nothing can decide or carry out.
--
-- Each is closed as EXPIRED with the reason on the row, once. Rows already
-- settled, anchored, rejected, failed, expired or reversed are history and are
-- left as they are, and so is every other kind. Nothing is dropped or deleted:
-- the proposals, their approvals and their audit trail stay readable. Running it
-- twice changes nothing, because an expired row no longer matches.
UPDATE "proposals"
SET "status" = 'EXPIRED',
    "execution_state" = 'SKIPPED',
    "execution_error" = 'Closed: payout runs are no longer carried out from an approval. Use Batch payouts, where your owners sign once. Nothing was sent.',
    "updated_at" = now()
WHERE "kind" = 'BATCH_PAYOUT'
  AND "status" IN ('DRAFTED', 'SIMULATED', 'POLICY_EVALUATED', 'PENDING_APPROVAL', 'APPROVED', 'SIGNED', 'SUBMITTED');
