-- Wallet recipients (v2 §4.7, D5).
--
-- 1. Every recipient says how it is paid: BANK, EXCHANGE (a deposit address
--    at an exchange, on Sui), SELF_CUSTODY (a wallet the supplier holds,
--    paid only once it signed the ownership proof) or CROSS_CHAIN (USDC over
--    CCTP V2 to another chain). The columns each kind needs are required for
--    it and empty for the others. Existing wallet recipients are wallets the
--    supplier holds; none has an ownership proof yet.
-- 2. recipient_ownership_challenges: the link Splash sends a self-custody
--    supplier. The link's token is kept only as its SHA-256; the nonce is
--    single-use; a challenge is used once, whatever the outcome.
-- 3. cross_chain_transfers: the receipt of a CCTP payment, keyed once per
--    business and payment: the Sui burn, Circle's attestation, the mint on
--    the destination chain. Forward only; a trigger refuses a step back.

ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "delivery_kind" text NOT NULL DEFAULT 'BANK';
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "exchange_id" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "deposit_network" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "destination_chain" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "destination_domain" integer;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "destination_address" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "mint_recipient" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "ownership_status" text;
--> statement-breakpoint
UPDATE "suppliers" SET "delivery_kind" = 'SELF_CUSTODY', "ownership_status" = 'unproven' WHERE "payout_method" = 'WALLET' AND "wallet_address" IS NOT NULL AND "delivery_kind" = 'BANK';
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_delivery_kind_check" CHECK ("delivery_kind" IN ('BANK', 'EXCHANGE', 'SELF_CUSTODY', 'CROSS_CHAIN'));
--> statement-breakpoint
-- Every CHECK below is written so that a NULL can never make it pass: a
-- CHECK that evaluates to NULL is accepted, so each test is COALESCEd.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_exchange_check" CHECK (
  CASE WHEN "delivery_kind" = 'EXCHANGE'
    THEN COALESCE("exchange_id" IN ('hata', 'pdax', 'tokocrypto', 'bitkub'), false) AND COALESCE("deposit_network" = 'SUI', false) AND "wallet_address" IS NOT NULL
    ELSE "exchange_id" IS NULL AND "deposit_network" IS NULL
  END
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_self_custody_check" CHECK (
  CASE WHEN "delivery_kind" = 'SELF_CUSTODY'
    THEN COALESCE("ownership_status" IN ('unproven', 'proven', 'revoked'), false) AND "wallet_address" IS NOT NULL
    ELSE "ownership_status" IS NULL
  END
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_cross_chain_check" CHECK (
  CASE WHEN "delivery_kind" = 'CROSS_CHAIN'
    THEN "destination_chain" IS NOT NULL AND "destination_domain" IS NOT NULL AND "destination_address" IS NOT NULL
      AND COALESCE("mint_recipient" ~ '^0x[0-9a-f]{64}$', false) AND "wallet_address" IS NULL AND "payout_method" = 'CROSS_CHAIN'
    ELSE "destination_chain" IS NULL AND "destination_domain" IS NULL AND "destination_address" IS NULL AND "mint_recipient" IS NULL
      AND "payout_method" <> 'CROSS_CHAIN'
  END
);
--> statement-breakpoint
-- 0020's rules, widened for the new kinds: CROSS_CHAIN is paid on another
-- chain (no Sui address); a WALLET recipient still needs a well-formed Sui
-- address; the wallet app is a label from a fixed list for a wallet the
-- supplier holds, and absent for an exchange account.
ALTER TABLE "suppliers" DROP CONSTRAINT IF EXISTS "suppliers_payout_method_check";
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payout_method_check" CHECK ("payout_method" IN ('BANK', 'WALLET', 'CROSS_CHAIN'));
--> statement-breakpoint
ALTER TABLE "suppliers" DROP CONSTRAINT IF EXISTS "suppliers_wallet_shape_check";
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_wallet_shape_check" CHECK (
  "payout_method" IN ('BANK', 'CROSS_CHAIN')
  OR (
    COALESCE("wallet_address" ~ '^0x[0-9a-f]{64}$', false)
    AND (
      ("delivery_kind" = 'EXCHANGE' AND "wallet_provider" IS NULL)
      OR COALESCE("wallet_provider" IN ('SLUSH', 'METAMASK_SUI_SNAP', 'BACKPACK', 'OTHER'), false)
    )
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_cross_chain_unique" ON "suppliers" ("org_id", "destination_chain", "destination_address") WHERE "delivery_kind" = 'CROSS_CHAIN';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_wallet_address_idx" ON "suppliers" ("org_id", "wallet_address") WHERE "wallet_address" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recipient_ownership_challenges" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "recipient_id" text NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
  "address" text NOT NULL,
  "token_sha256" text NOT NULL,
  "nonce" text NOT NULL,
  "message" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_by" text NOT NULL,
  "sent_to" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "used_at" timestamp with time zone,
  "outcome" text,
  CONSTRAINT "recipient_ownership_challenges_token_unique" UNIQUE ("token_sha256"),
  CONSTRAINT "recipient_ownership_challenges_nonce_unique" UNIQUE ("nonce"),
  CONSTRAINT "recipient_ownership_challenges_nonce_check" CHECK ("nonce" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "recipient_ownership_challenges_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('verified', 'bad_signature', 'superseded', 'withdrawn')),
  CONSTRAINT "recipient_ownership_challenges_used_check" CHECK (("used_at" IS NULL) = ("outcome" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipient_ownership_challenges_recipient_idx" ON "recipient_ownership_challenges" ("org_id", "recipient_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cross_chain_transfers" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "payment_ref" text NOT NULL,
  "recipient_id" text REFERENCES "suppliers"("id") ON DELETE SET NULL,
  "destination_chain" text NOT NULL,
  "destination_domain" integer NOT NULL,
  "mint_recipient" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "max_bridge_fee_minor" bigint DEFAULT 0 NOT NULL,
  "status" text NOT NULL,
  "burn_digest" text,
  "burned_at" timestamp with time zone,
  "message" text,
  "message_nonce" text,
  "attestation" text,
  "attested_at" timestamp with time zone,
  "minted_amount_minor" bigint,
  "mint_tx_hash" text,
  "minted_at" timestamp with time zone,
  "sandbox" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cross_chain_transfers_payment_unique" UNIQUE ("org_id", "payment_ref"),
  CONSTRAINT "cross_chain_transfers_burn_unique" UNIQUE ("burn_digest"),
  CONSTRAINT "cross_chain_transfers_nonce_unique" UNIQUE ("message_nonce"),
  CONSTRAINT "cross_chain_transfers_mint_unique" UNIQUE ("destination_chain", "mint_tx_hash"),
  CONSTRAINT "cross_chain_transfers_amount_check" CHECK ("amount_minor" > 0 AND "max_bridge_fee_minor" >= 0 AND "max_bridge_fee_minor" < "amount_minor"),
  CONSTRAINT "cross_chain_transfers_mint_recipient_check" CHECK ("mint_recipient" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "cross_chain_transfers_status_check" CHECK ("status" IN ('awaiting_burn', 'burned', 'attested', 'minted')),
  CONSTRAINT "cross_chain_transfers_steps_check" CHECK (
    ("status" = 'awaiting_burn' AND "burn_digest" IS NULL)
    OR ("status" = 'burned' AND "burn_digest" IS NOT NULL AND "burned_at" IS NOT NULL AND "attestation" IS NULL)
    OR ("status" = 'attested' AND "burn_digest" IS NOT NULL AND "message" IS NOT NULL AND "message_nonce" IS NOT NULL AND "attestation" IS NOT NULL AND "attested_at" IS NOT NULL AND "mint_tx_hash" IS NULL)
    OR ("status" = 'minted' AND "burn_digest" IS NOT NULL AND "attestation" IS NOT NULL AND "mint_tx_hash" IS NOT NULL AND "minted_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cross_chain_transfers_forward_only() RETURNS trigger AS $$
DECLARE
  rank_old integer;
  rank_new integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cross_chain_transfers keeps every receipt';
  END IF;
  rank_old := array_position(ARRAY['awaiting_burn', 'burned', 'attested', 'minted'], OLD.status);
  rank_new := array_position(ARRAY['awaiting_burn', 'burned', 'attested', 'minted'], NEW.status);
  IF rank_new < rank_old THEN
    RAISE EXCEPTION 'cross_chain_transfers moves forward only (% to %)', OLD.status, NEW.status;
  END IF;
  IF OLD.burn_digest IS NOT NULL AND NEW.burn_digest IS DISTINCT FROM OLD.burn_digest THEN
    RAISE EXCEPTION 'a recorded burn is never replaced';
  END IF;
  IF OLD.attestation IS NOT NULL AND (NEW.attestation IS DISTINCT FROM OLD.attestation OR NEW.message_nonce IS DISTINCT FROM OLD.message_nonce) THEN
    RAISE EXCEPTION 'a recorded attestation is never replaced';
  END IF;
  IF OLD.mint_tx_hash IS NOT NULL AND NEW.mint_tx_hash IS DISTINCT FROM OLD.mint_tx_hash THEN
    RAISE EXCEPTION 'a recorded mint is never replaced';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.payment_ref IS DISTINCT FROM OLD.payment_ref OR NEW.mint_recipient IS DISTINCT FROM OLD.mint_recipient
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.destination_domain IS DISTINCT FROM OLD.destination_domain THEN
    RAISE EXCEPTION 'what a cross-chain payment pays is fixed when it is opened';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cross_chain_transfers_no_regression" ON "cross_chain_transfers";
--> statement-breakpoint
CREATE TRIGGER "cross_chain_transfers_no_regression" BEFORE UPDATE OR DELETE ON "cross_chain_transfers"
  FOR EACH ROW EXECUTE FUNCTION cross_chain_transfers_forward_only();
