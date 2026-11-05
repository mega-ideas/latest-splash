-- Compliance fixes after the §4.6 review.
--
-- 1. A provider's reference is kept once per business AND per address: one
--    answer covering two addresses (a sanctions-list answer, say) is two
--    rows, and neither address is ever handed the other's row.
-- 2. A Travel Rule message is claimed before it is sent (`sending`), and a
--    send whose outcome is unknown (Sumsub says it already has that txnId)
--    is held as `unconfirmed` until Sumsub's webhook names it.

DROP INDEX IF EXISTS "kyt_screenings_reference_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kyt_screenings_reference_unique" ON "kyt_screenings" ("org_id", "provider", "reference", "chain", "address") WHERE "reference" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "travel_rule_transfers" DROP CONSTRAINT IF EXISTS "travel_rule_transfers_status_check";
--> statement-breakpoint
ALTER TABLE "travel_rule_transfers" ADD CONSTRAINT "travel_rule_transfers_status_check" CHECK ("status" IN ('preparing', 'sending', 'unconfirmed', 'submitted', 'awaiting_counterparty', 'on_hold', 'approved', 'rejected'));
