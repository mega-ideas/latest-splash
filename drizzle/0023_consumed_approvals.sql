-- An approval pays once.
--
-- A payment over the dual-approval threshold becomes a proposal. When its
-- approvers finish, the queue replays the payment through the real authorize
-- route with `x-splash-approved-proposal: <id>`, and the route lifts the
-- second-approver requirement for it (lib/server/approved-proposal.ts).
--
-- That claim was checked for existence, org, status and signatures, and had
-- two holes:
--
--   The batch route did not bind it to the run. Any member of the org could
--   attach any approved proposal's id to a different batch and skip the
--   second approver. (Closed in code: every route now compares the approved
--   payload with its own request, by digest, before honouring the claim.)
--
--   Nothing recorded that it had been used. SUBMITTED, SETTLED and ANCHORED
--   all counted as approved, so the same approved payment could be sent again
--   after it executed, with no second approver.
--
-- A row here means the approval has been spent. The first money route to act
-- on the claim inserts it; the approvers' replay inserts it when the route
-- refused before reaching the claim. The primary key is the control: every
-- later attempt, from another request or another process, conflicts and is
-- refused.
--
-- No foreign key to "proposals": the proposal store is in memory and its
-- write-through is best-effort, so the proposal row may not exist. The spend
-- must not depend on it.
CREATE TABLE "consumed_approvals" (
  "proposal_id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  -- What spent it: the route that acted on the claim, 'execution' when the
  -- replay closed it, 'backfill' below.
  "consumed_by" text NOT NULL,
  "consumed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Approvals already carried out, or already at the point of being carried out,
-- are spent. Without this, every proposal that executed before the table
-- existed would carry a claim the new code honours once more.
INSERT INTO "consumed_approvals" ("proposal_id", "org_id", "consumed_by", "consumed_at")
SELECT "id", "org_id", 'backfill', COALESCE("executed_at", "updated_at")
FROM "proposals"
WHERE "status" IN ('SUBMITTED', 'SETTLED', 'ANCHORED', 'REVERSED')
   OR "execution_state" IS NOT NULL
ON CONFLICT ("proposal_id") DO NOTHING;
