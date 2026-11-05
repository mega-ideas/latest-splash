-- The second review of Invoices (v2 brief 5.8).
--
-- Pay invoices: the attempt at paying an invoice. It is part of the key the
-- payment flow is handed, and it goes up whenever an intent closes unpaid,
-- is withdrawn, or the invoice is taken back to review, so a later approval
-- is never answered with a dead intent.
ALTER TABLE "payable_invoices" ADD COLUMN IF NOT EXISTS "payment_attempt" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Get paid: who the payer said they were on the pay link, kept apart from the
-- payer the issuer named, which a report never replaces.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "payer_reported_name" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "payer_reported_email" text;
--> statement-breakpoint
-- The reference on the business's own statement, typed when it marked the
-- invoice paid. The reference the payer was asked to quote stays as it was.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "received_reference" text;
