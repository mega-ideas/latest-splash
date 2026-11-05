-- Spending rules (v2 §4.2).
--
-- 1. Three more things a wallet signing request can be: the wallet creating
--    its SpendPolicy (`spend_policy`), the wallet giving, changing or taking
--    back spending rules or changing the policy (`spend_rule`), and one
--    owner's second approval of a payment (`spend_approval`).
-- 2. `wallet_ownership_proofs`: an address the business has proved belongs
--    to the payee, by the payee signing Splash's fixed message (§4.7 builds
--    the proof itself). A1 §2.3: only such an address may be verified on a
--    SpendPolicy with the WALLET tag (2 bps); this table is the gate.

ALTER TABLE "wallet_signing_requests" DROP CONSTRAINT IF EXISTS "wallet_signing_requests_purpose_check";
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" ADD CONSTRAINT "wallet_signing_requests_purpose_check" CHECK ("purpose" IN ('nominate_wallet', 'register_wallet', 'rotate_wallet', 'confirm_wallet_rotation', 'cancel_wallet_rotation', 'wallet_membership', 'wallet_payment', 'migration_transfer', 'rotation_transfer', 'spend_policy', 'spend_rule', 'spend_approval'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_ownership_proofs" (
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  -- A Sui address, 0x and 64 lowercase hex digits.
  "address" text NOT NULL,
  -- How it was proved, for example a signed message from the payee's wallet.
  "method" text NOT NULL,
  -- SHA-256 of the evidence (the signed message and signature), not the evidence.
  "evidence_sha256" text NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  PRIMARY KEY ("org_id", "address"),
  CONSTRAINT "wallet_ownership_proofs_address_check" CHECK ("address" ~ '^0x[0-9a-f]{64}$')
);
