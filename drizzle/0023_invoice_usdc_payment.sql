-- An invoice paid in USDC on Sui, straight to the issuer's own Splash wallet
-- (the address of their passkey; Splash never holds the funds), records the
-- transaction that proved it. Splash matches the payment on chain by its
-- exact amount — the invoice amount plus a per-invoice suffix of a few
-- millionths of a dollar — and reads it back before recording it.
ALTER TABLE "invoices" ADD COLUMN "usdc_tx_digest" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "usdc_paid_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "usdc_payer_address" text;
--> statement-breakpoint
-- The wallet the payer was shown, pinned the first time it is shown: if the
-- main admin changes or re-enrols, a payment already sent still matches.
ALTER TABLE "invoices" ADD COLUMN "usdc_receive_address" text;
--> statement-breakpoint
-- One transaction pays one invoice: two invoices of the same amount can never
-- both claim the same transfer.
CREATE UNIQUE INDEX "invoices_usdc_tx_digest_unique" ON "invoices" ("usdc_tx_digest");
--> statement-breakpoint
-- A recorded payment always says when. COALESCE because a CHECK that
-- evaluates to NULL passes.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_usdc_paid_check" CHECK (
  "usdc_tx_digest" IS NULL OR COALESCE("usdc_paid_at" IS NOT NULL, false)
);
