-- Scheduled batches (v2 Phase 3, review fix): the daily limit an owner asks for
-- waits for the owners' signatures.
--
-- Asking for an allowance used to write the new daily limit at once, before the
-- owners had signed, so one owner's call could raise the limit the signed
-- allowance was meant to fix. Now the limit asked for is kept here, with the
-- signing request that will make it real. It becomes the daily limit when that
-- request executes, and is dropped when the request ends any other way.
ALTER TABLE "scheduled_payment_settings" ADD COLUMN IF NOT EXISTS "pending_daily_cap_minor" bigint;
--> statement-breakpoint
ALTER TABLE "scheduled_payment_settings" ADD COLUMN IF NOT EXISTS "pending_cap_request_id" text;
--> statement-breakpoint
ALTER TABLE "scheduled_payment_settings" DROP CONSTRAINT IF EXISTS "scheduled_payment_settings_pending_check";
--> statement-breakpoint
ALTER TABLE "scheduled_payment_settings" ADD CONSTRAINT "scheduled_payment_settings_pending_check" CHECK (("pending_daily_cap_minor" IS NULL) = ("pending_cap_request_id" IS NULL) AND ("pending_daily_cap_minor" IS NULL OR "pending_daily_cap_minor" > 0));
