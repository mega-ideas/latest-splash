-- Funding sessions, out of `lib/server/funding-sessions.ts` and into the database.
--
-- Three `Map`s on `globalThis` held them: the sessions, the registry that stops
-- one on-chain deposit being credited to two sessions, and the last-used
-- funding source. On serverless each instance had its own, so a deposit webhook
-- answered by another instance found no session, and the registry guarded only
-- the instance it happened to live in.
--
-- `org_id` is NOT NULL with a foreign key to `organizations` on every table.
-- Amounts are bigint micro units, never float.

CREATE TABLE IF NOT EXISTS "funding_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "business_account_id" text NOT NULL,
  "selection" jsonb NOT NULL,
  "fee_tier" text NOT NULL,
  "amount_expected_micro" bigint NOT NULL CHECK ("amount_expected_micro" > 0),
  "deposit_address" text,
  "deposit_uri" text,
  "status" text NOT NULL DEFAULT 'AWAITING_DEPOSIT'
    CHECK ("status" IN ('AWAITING_DEPOSIT', 'PENDING_KYT', 'CLEARED', 'PENDING_CONVERT', 'QUARANTINED', 'CREDITED')),
  "source_type" text,
  "kyt_policy" text,
  "kyt_reasons" jsonb,
  "source_tx_digest" text,
  "received_coin_type" text,
  "received_amount_micro" bigint CHECK ("received_amount_micro" IS NULL OR "received_amount_micro" >= 0),
  "native_sui_usdc" boolean,
  "normalized_amount_usdc_micro" bigint CHECK ("normalized_amount_usdc_micro" IS NULL OR "normalized_amount_usdc_micro" >= 0),
  "normalize_venue" text,
  "effective_slippage_bps" integer,
  "transfer_intent_id" text,
  "admin_flag" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funding_sessions_org_created_idx" ON "funding_sessions" ("org_id", "created_at");
--> statement-breakpoint
-- The staff transactions console lists every session by recency.
CREATE INDEX IF NOT EXISTS "funding_sessions_created_idx" ON "funding_sessions" ("created_at");
--> statement-breakpoint
-- One deposit, one session. The digest is the key, so a second claim from any
-- instance, at any time or at the same moment, finds the first owner.
CREATE TABLE IF NOT EXISTS "funding_source_transactions" (
  "tx_digest" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL REFERENCES "funding_sessions"("id"),
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Keyed by org and account: the account id alone is shared by every org on the
-- fallback id, and one org's last choice became another's default.
CREATE TABLE IF NOT EXISTS "funding_last_used_sources" (
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "business_account_id" text NOT NULL,
  "source" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("org_id", "business_account_id")
);
