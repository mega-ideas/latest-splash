-- The review of Invoices (v2 brief 5.8).
--
-- Pay invoices: the same supplier invoice number cannot be scheduled, waiting
-- for approval or paid twice to the same recipient, however the supplier's
-- name was typed. 0057's index is keyed on the typed name; this one is keyed
-- on who is actually paid.
CREATE UNIQUE INDEX IF NOT EXISTS "payable_invoices_recipient_number_once_unique" ON "payable_invoices" ("org_id", "recipient_id", "invoice_number_key") WHERE "status" IN ('scheduled', 'approving', 'paid');
--> statement-breakpoint
-- Why a recipient unlike the confirmed supplier was chosen, in the words of
-- the person who chose it.
ALTER TABLE "payable_invoices" ADD COLUMN IF NOT EXISTS "match_reason" text;
--> statement-breakpoint
-- The network the payment settled on, so the receipt links the right explorer.
ALTER TABLE "payable_invoices" ADD COLUMN IF NOT EXISTS "sui_network" text CHECK ("sui_network" IS NULL OR "sui_network" IN ('testnet', 'mainnet'));
--> statement-breakpoint
-- Get paid: what a payer says from the pay link is kept apart from the
-- issuer's own payment reference, which it never replaces.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "payer_reported_reference" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "payer_reported_at" timestamp with time zone;
