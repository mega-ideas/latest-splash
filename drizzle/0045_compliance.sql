-- Compliance (v2 §4.6).
--
-- 1. `kyt_screenings`: every KYT screening of an address a business pays or
--    is paid from (a deposit's sender, a wallet, exchange or cross-chain
--    recipient): the provider, its own reference and its verdict, or a null
--    verdict when there was no answer. Append-only (a trigger refuses UPDATE
--    and DELETE); a provider's reference is kept once per business.
-- 2. `travel_rule_transfers`: the Travel Rule message for one payment to an
--    exchange recipient, once per payment (org, payment_ref). Sumsub's own
--    reference is unique per provider; the status moves forward only.

CREATE TABLE IF NOT EXISTS "kyt_screenings" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "subject_kind" text NOT NULL,
  "chain" text NOT NULL,
  "address" text NOT NULL,
  "tx_ref" text,
  "provider" text NOT NULL,
  "verdict" text,
  "reference" text,
  "risk_score" numeric,
  "detail" text NOT NULL,
  "screened_at" timestamp with time zone,
  "requested_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "kyt_screenings_kind_check" CHECK ("subject_kind" IN ('deposit', 'wallet_recipient', 'exchange_recipient', 'cross_chain_recipient')),
  CONSTRAINT "kyt_screenings_verdict_check" CHECK ("verdict" IS NULL OR "verdict" IN ('CLEAR', 'REVIEW', 'BLOCK')),
  CONSTRAINT "kyt_screenings_answered_check" CHECK ("verdict" IS NULL OR ("reference" IS NOT NULL AND "screened_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kyt_screenings_reference_unique" ON "kyt_screenings" ("org_id", "provider", "reference") WHERE "reference" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kyt_screenings_subject_idx" ON "kyt_screenings" ("org_id", "chain", "address", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kyt_screenings_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'kyt_screenings is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "kyt_screenings_no_rewrite" ON "kyt_screenings";
--> statement-breakpoint
CREATE TRIGGER "kyt_screenings_no_rewrite" BEFORE UPDATE OR DELETE ON "kyt_screenings"
  FOR EACH ROW EXECUTE FUNCTION kyt_screenings_append_only();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "travel_rule_transfers" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "payment_ref" text NOT NULL,
  "signing_request_id" text,
  "exchange" text NOT NULL,
  "deposit_address" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "request_hash" text NOT NULL,
  "provider" text NOT NULL,
  "sandbox" boolean NOT NULL,
  "provider_ref" text,
  "status" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "travel_rule_transfers_status_check" CHECK ("status" IN ('preparing', 'submitted', 'awaiting_counterparty', 'on_hold', 'approved', 'rejected')),
  CONSTRAINT "travel_rule_transfers_amount_check" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "travel_rule_transfers_payment_unique" ON "travel_rule_transfers" ("org_id", "payment_ref");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "travel_rule_transfers_provider_ref_unique" ON "travel_rule_transfers" ("provider", "provider_ref") WHERE "provider_ref" IS NOT NULL;
