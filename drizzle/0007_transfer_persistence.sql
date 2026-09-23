-- Persist transfers, and make them belong to somebody.
--
-- `payment_intents` was designed for this record and never wired up: the
-- operational transfer lived in a process-global JS Map, which meant it did not
-- survive a restart AND — the part that matters more — it carried no org id at
-- all. One Map, every tenant, no scoping on read. Any code path that listed
-- transfers listed everybody's.
--
-- The table already had org_id, the bigint minor units, the funding fields, the
-- Sui digest and the audit anchor id. Three things were missing.

-- 1. The settlement metadata with no column of its own — the stablecoin and
--    rail chosen, the DAX tier, the peg-check verdict, the composed on-chain
--    actions, the Seal policy id. These are attributes of one settlement rather
--    than dimensions anyone queries across, so they go in one jsonb rather than
--    twenty sparse columns.
ALTER TABLE "payment_intents" ADD COLUMN "settlement_metadata" jsonb;--> statement-breakpoint

-- 2. The recipient as the operator typed it, before it resolves to a supplier
--    row. A transfer can name a beneficiary that has no supplier record yet.
ALTER TABLE "payment_intents" ADD COLUMN "recipient_name" text;--> statement-breakpoint

-- 3. Delivery tier decides whether funds are paid out, swept, or held as a
--    stored balance, and it is read on the settlement path.
ALTER TABLE "payment_intents" ADD COLUMN "delivery_tier" text;--> statement-breakpoint

-- Listing a tenant's transfers newest-first is the single most common read, and
-- it must never be able to scan another tenant's rows.
CREATE INDEX "intents_org_created_idx" ON "payment_intents" USING btree ("org_id", "created_at" DESC);--> statement-breakpoint

-- A transition that cannot say WHY is half a record. FAILED is the state an
-- operator actually has to reconcile, and "it failed" without a reason sends
-- them to the logs of a process that has since restarted.
ALTER TABLE "intent_transitions" ADD COLUMN "reason" text;

-- Idempotency was globally unique rather than per-org. The first tenant to use
-- "payroll-friday" blocked every other tenant from that key forever — a
-- cross-tenant denial of service through a field the client chooses.
-- `proposals_idempotency_unique` already scopes by org; this now matches it.
DROP INDEX IF EXISTS "intents_idempotency_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "intents_idempotency_unique" ON "payment_intents" USING btree ("org_id", "idempotency_key");
