-- Withdrawals, after review (v2 §4.4).
--
-- 1. `returned_minor`: the USDC a return put back into the business wallet,
--    as the chain shows it. Only the whole amount closes a withdrawal as
--    returned; a short return is recorded here and the withdrawal stays open
--    for review.
-- 2. One return digest closes one withdrawal, ever.
-- 3. `intent_confirmed_at`: when the executed transaction was read and its
--    IntentCreated event named this withdrawal's intent id. The digest is
--    posted to the partner only after that.
-- 4. `settlement_hold`: why the digest is not posted (`intent_id_mismatch`),
--    for ops. A held settlement is never posted by the sweep.

ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "returned_minor" bigint;
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "intent_confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "settlement_hold" text;
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_returned_check" CHECK ("returned_minor" IS NULL OR "returned_minor" > 0);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_return_digest_unique" ON "withdrawals" ("return_digest") WHERE "return_digest" IS NOT NULL;
