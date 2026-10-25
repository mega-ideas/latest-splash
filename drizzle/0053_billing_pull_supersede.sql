-- Subscription billing review fixes (A1 §6; still behind
-- FEATURE_SUBSCRIPTION_BILLING, off).
--
-- 1. A pull may be `superseded`: it was built under a plan since replaced and
--    never drawn (failed, or never signed). The month is then billed again
--    under the plan in force, on a new row with its own invoice, so the
--    amount drawn, the invoice and the receipt always name the same plan.
-- 2. At most one pull per business per calendar month that is not
--    superseded: the unique index becomes partial. A drawn (succeeded) or
--    sent (submitted) pull is never superseded, so a month is still drawn
--    at most once.
-- 3. The invoice of a superseded pull is void (`voided_at`), not deleted.

ALTER TABLE "subscription_pulls" DROP CONSTRAINT IF EXISTS "subscription_pulls_status_check";
--> statement-breakpoint
ALTER TABLE "subscription_pulls" ADD CONSTRAINT "subscription_pulls_status_check" CHECK ("status" IN ('awaiting_signature', 'submitted', 'succeeded', 'failed', 'superseded'));
--> statement-breakpoint
DROP INDEX IF EXISTS "subscription_pulls_org_period_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_pulls_org_period_unique" ON "subscription_pulls" ("org_id", "period") WHERE status <> 'superseded';
--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone;
