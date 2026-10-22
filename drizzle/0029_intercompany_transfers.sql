-- Intercompany legs (Splash US -> Splash Labuan), out of a process map.
--
-- `lib/server/intercompany.ts` kept every leg in a `Map` on `globalThis`, and
-- the daily reconciliation summed that map, so each serverless instance
-- reconciled only the legs it had created and a cold start reconciled nothing.
--
-- `org_id` is NOT NULL with a foreign key to `organizations`. Amounts are
-- bigint micro units; the rate is exact numeric.

CREATE TABLE IF NOT EXISTS "intercompany_transfers" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "transfer_intent_id" text NOT NULL,
  "amount_usd_micro" bigint NOT NULL CHECK ("amount_usd_micro" >= 0),
  "amount_usdc_micro" bigint NOT NULL DEFAULT 0 CHECK ("amount_usdc_micro" >= 0),
  "usd_to_usdc_rate" numeric NOT NULL,
  "maybank_ref" text NOT NULL DEFAULT '',
  "labuan_settlement_id" text NOT NULL DEFAULT '',
  "state" text NOT NULL DEFAULT 'INITIATED'
    CHECK ("state" IN ('INITIATED', 'FX_CONFIRMED', 'USD_SENT', 'USD_RECEIVED', 'USDC_ACQUIRED', 'SETTLED', 'FAILED')),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One leg per customer transfer: a second would send the USD twice.
CREATE UNIQUE INDEX IF NOT EXISTS "intercompany_transfer_unique" ON "intercompany_transfers" ("transfer_intent_id");
--> statement-breakpoint
-- The daily reconciliation reads one day's rows across every org.
CREATE INDEX IF NOT EXISTS "intercompany_created_idx" ON "intercompany_transfers" ("created_at");
