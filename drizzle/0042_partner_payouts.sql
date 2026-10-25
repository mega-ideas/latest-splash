-- Payouts to a supplier's bank through the payout partners (v2 §4.5), on the
-- same rails as withdrawals to the business's own bank (§4.4, 0040, 0041):
-- business wallet → the business's fixed deposit address at the partner →
-- the partner converts and pays the supplier's bank. PH through the
-- Philippines payout partner (pdax), ID through the Indonesia payout partner
-- and its exchange partner (durianpay). Splash never receives the local
-- currency, and no Splash address is on the path.
--
-- 1. `withdrawal_destinations.kind`: `own_account` (a withdrawal, checked
--    against the business's registered name) or `supplier` (a payout to
--    another business, checked against the name the bank holds for the
--    account). A supplier carries its ISO 20022 party (structured address and
--    registration number), sealed like the account number, and the payer's
--    relationship to it.
-- 2. `withdrawals.kind`: `withdrawal` or `supplier_payout`. A payout carries
--    its ISO 20022 purpose code and the masked pacs.008-style evidence the
--    controls-evidence export shows (the partner was sent the full message).
--    Every other column, unique index and the append-only trail are shared:
--    one intent id, one payment ref, one partner ref, one digest, one return.
-- 3. A new signing purpose, `partner_payout`: the same shape as a withdrawal
--    (a kind 4 payout to the verified deposit address, for the beneficiary's
--    commitment, of exactly the instructed amount), named for what it is.

ALTER TABLE "wallet_signing_requests" DROP CONSTRAINT IF EXISTS "wallet_signing_requests_purpose_check";
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" ADD CONSTRAINT "wallet_signing_requests_purpose_check" CHECK ("purpose" IN ('nominate_wallet', 'register_wallet', 'rotate_wallet', 'confirm_wallet_rotation', 'cancel_wallet_rotation', 'wallet_membership', 'wallet_payment', 'migration_transfer', 'rotation_transfer', 'spend_policy', 'spend_rule', 'spend_approval', 'withdrawal', 'partner_test_deposit', 'partner_payout'));
--> statement-breakpoint
ALTER TABLE "withdrawal_destinations" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'own_account' NOT NULL;
--> statement-breakpoint
ALTER TABLE "withdrawal_destinations" ADD COLUMN IF NOT EXISTS "party_sealed" text;
--> statement-breakpoint
ALTER TABLE "withdrawal_destinations" ADD COLUMN IF NOT EXISTS "relationship" text;
--> statement-breakpoint
ALTER TABLE "withdrawal_destinations" ADD CONSTRAINT "withdrawal_destinations_kind_check" CHECK (
  ("kind" = 'own_account' AND "party_sealed" IS NULL)
  OR ("kind" = 'supplier' AND "party_sealed" IS NOT NULL AND "relationship" IS NOT NULL AND "relationship" <> 'self')
);
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'withdrawal' NOT NULL;
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "purpose_code" text;
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "iso20022" jsonb;
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_kind_check" CHECK (
  ("kind" = 'withdrawal')
  OR ("kind" = 'supplier_payout' AND "purpose_code" IS NOT NULL AND "iso20022" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_org_kind_idx" ON "withdrawals" ("org_id", "kind", "status");
