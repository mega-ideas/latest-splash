-- Funding the Business Splash Wallet ("Add funds", v2 §4.3).
--
-- 1. `funding_sources`: a bank account in the company's name, a card, or a
--    wallet the business proved it controls. Identified by a fingerprint
--    (a SHA-256 of the account, card or address), never the full account or
--    card number; one row per org and source.
-- 2. `funding_source_challenges`: the single-use message a business signs
--    with a wallet to prove it controls it.
-- 3. `funding_intents`: one top-up. Its id is the idempotency key sent to a
--    funding partner; a client key makes a retried click open nothing new.
--    Every intent names the business wallet as its destination.
-- 4. `wallet_deposits`: money that arrived in the business wallet, read from
--    the chain. One row per (transaction, wallet, coin type), so a deposit is
--    recorded once however often it is reported. Held, cleared or blocked.
-- 5. `funding_provider_events`: each partner webhook once, by its event id.

CREATE TABLE IF NOT EXISTS "funding_sources" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "holder_name" text,
  "fingerprint" text NOT NULL,
  "last4" text,
  "chain" text,
  "address" text,
  "provider" text,
  "status" text NOT NULL,
  "method" text,
  "evidence_sha256" text,
  "verified_at" timestamp with time zone,
  "verified_by" text,
  "rejected_reason" text,
  "revoked_at" timestamp with time zone,
  "first_use_at" timestamp with time zone,
  "first_use_result" text,
  "first_use_detail" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "funding_sources_kind_check" CHECK ("kind" IN ('bank_account', 'card', 'wallet')),
  CONSTRAINT "funding_sources_status_check" CHECK ("status" IN ('pending', 'verified', 'rejected', 'revoked')),
  CONSTRAINT "funding_sources_first_use_check" CHECK ("first_use_result" IS NULL OR "first_use_result" IN ('passed', 'failed')),
  CONSTRAINT "funding_sources_wallet_check" CHECK ("kind" <> 'wallet' OR ("chain" IS NOT NULL AND "address" IS NOT NULL)),
  CONSTRAINT "funding_sources_last4_check" CHECK ("last4" IS NULL OR "last4" ~ '^[A-Z0-9]{4}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "funding_sources_org_fingerprint_unique" ON "funding_sources" ("org_id", "kind", "fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funding_sources_wallet_idx" ON "funding_sources" ("org_id", "chain", "address");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "funding_source_challenges" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "source_id" text NOT NULL REFERENCES "funding_sources"("id"),
  "message" text NOT NULL,
  "nonce" text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "funding_intents" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "client_key" text NOT NULL,
  "channel" text NOT NULL,
  "provider" text,
  "method" text,
  "source_id" text REFERENCES "funding_sources"("id"),
  "asset" text NOT NULL,
  "source_chain" text,
  "amount_minor" bigint NOT NULL,
  "wallet_address" text NOT NULL,
  "quote" jsonb,
  "instructions" jsonb,
  "status" text NOT NULL,
  "provider_ref" text,
  "purpose" text NOT NULL,
  "transfer_ref" text,
  "arrived_deposit_id" text,
  "failure" text,
  "created_by" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "funding_intents_channel_check" CHECK ("channel" IN ('provider', 'wallet', 'cctp', 'swap')),
  CONSTRAINT "funding_intents_status_check" CHECK ("status" IN ('awaiting_funds', 'provider_pending', 'arrived', 'failed', 'expired', 'cancelled')),
  CONSTRAINT "funding_intents_purpose_check" CHECK ("purpose" IN ('top_up', 'transfer_top_up')),
  CONSTRAINT "funding_intents_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "funding_intents_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "funding_intents_client_key_unique" ON "funding_intents" ("org_id", "client_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "funding_intents_provider_ref_unique" ON "funding_intents" ("provider", "provider_ref") WHERE "provider_ref" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funding_intents_org_idx" ON "funding_intents" ("org_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_deposits" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "wallet_address" text NOT NULL,
  "sui_digest" text NOT NULL,
  "coin_type" text NOT NULL,
  "asset" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "channel" text NOT NULL,
  "intent_id" text REFERENCES "funding_intents"("id"),
  "source_id" text REFERENCES "funding_sources"("id"),
  "sender" text,
  "origin_chain" text,
  "origin_address" text,
  "status" text NOT NULL,
  "hold_reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "screening" jsonb NOT NULL,
  "first_use" boolean NOT NULL DEFAULT false,
  "arrived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_deposits_status_check" CHECK ("status" IN ('held', 'cleared', 'blocked')),
  CONSTRAINT "wallet_deposits_asset_check" CHECK ("asset" IN ('USDC', 'USDT', 'USDSUI')),
  CONSTRAINT "wallet_deposits_channel_check" CHECK ("channel" IN ('provider', 'wallet', 'cctp', 'swap')),
  CONSTRAINT "wallet_deposits_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "wallet_deposits_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_deposits_arrival_unique" ON "wallet_deposits" ("sui_digest", "wallet_address", "coin_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_deposits_org_idx" ON "wallet_deposits" ("org_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "funding_provider_events" (
  "provider" text NOT NULL,
  "event_id" text NOT NULL,
  "org_id" text REFERENCES "organizations"("id"),
  "intent_id" text,
  "status" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("provider", "event_id")
);
