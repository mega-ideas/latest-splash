-- ATTESTED: no screening provider was configured, and a named admin vouched
-- for the wallet. The only unscreened path to a mainnet send, and it is
-- recorded with who and when in screening_reference.
ALTER TYPE "screening_verdict" ADD VALUE IF NOT EXISTS 'ATTESTED';
--> statement-breakpoint
-- The stablecoin lane: wallet recipients, a per-workspace settlement network,
-- and the outflow ledger that enforces the shared 30-day allowance.
ALTER TABLE "suppliers" ADD COLUMN "payout_method" text DEFAULT 'BANK' NOT NULL;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "wallet_address" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "wallet_provider" text;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stablecoin_network" text DEFAULT 'testnet' NOT NULL;
--> statement-breakpoint
CREATE TABLE "stablecoin_outflows" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "kind" text NOT NULL,
  "supplier_id" text REFERENCES "suppliers"("id"),
  "network" text NOT NULL,
  "coin_type" text NOT NULL,
  "principal_minor" bigint NOT NULL,
  "fee_minor" bigint NOT NULL,
  "sender_address" text NOT NULL,
  "recipient_address" text NOT NULL,
  "fee_address" text,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "reserved_until" timestamp with time zone NOT NULL,
  "tx_digest" text UNIQUE,
  "anchor_status" text NOT NULL,
  "audit_anchor_id" text,
  "resource" text,
  "failure_reason" text,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stablecoin_outflows_kind_check" CHECK ("kind" IN ('TRANSFER', 'X402')),
  CONSTRAINT "stablecoin_outflows_network_check" CHECK ("network" IN ('mainnet', 'testnet')),
  CONSTRAINT "stablecoin_outflows_status_check" CHECK ("status" IN ('PENDING', 'CONFIRMED', 'FAILED', 'MISMATCH', 'EXPIRED')),
  CONSTRAINT "stablecoin_outflows_positive_check" CHECK ("principal_minor" > 0 AND "fee_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX "stablecoin_outflows_org_created_idx" ON "stablecoin_outflows" ("org_id", "created_at");
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payout_method_check" CHECK ("payout_method" IN ('BANK', 'WALLET'));
--> statement-breakpoint
-- A WALLET recipient without a well-formed, lower-case Sui address is a row a
-- send could read and pay to nowhere. The route validates; this makes it true.
-- COALESCE because a CHECK that evaluates to NULL PASSES: without it, a NULL
-- address makes the regex test NULL and the row is accepted.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_wallet_shape_check" CHECK (
  "payout_method" = 'BANK'
  OR (
    COALESCE("wallet_address" ~ '^0x[0-9a-f]{64}$', false)
    AND COALESCE("wallet_provider" IN ('SLUSH', 'METAMASK_SUI_SNAP'), false)
  )
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_stablecoin_network_check" CHECK ("stablecoin_network" IN ('mainnet', 'testnet'));
