-- Funding the Business Splash Wallet: the independent review of §4.3.
--
-- 1. `wallet_deposits.part`: one transaction can carry two deposits of the
--    same coin to the wallet: a CCTP mint ('arrival', credited to the burner
--    up to what Circle minted) and whatever else the transaction moved in
--    ('remainder', the sender's, screened as the sender's). The arrival key
--    becomes (transaction, wallet, coin type, part).
-- 2. `funding_intents.status` gains 'arriving': money came for the top-up,
--    but cleared USDC does not yet cover what it promised. 'arrived' only
--    when it does.
-- 3. `wallet_deposit_sync`: the deposit watcher's place in each wallet's
--    history (the indexer's cursor) and the net USDC it has seen move, so
--    USDC the watcher has not accounted for is withheld, never spent.
-- 4. `funding_source_events`: an append-only trail of every funding-source
--    change (added, verified, revoked, first use), who and with what
--    evidence. A trigger refuses UPDATE and DELETE.
-- 5. A revoked source may be added again as a new pending row: the
--    one-per-fingerprint rule now covers live rows only.

ALTER TABLE "wallet_deposits" ADD COLUMN IF NOT EXISTS "part" text DEFAULT 'arrival' NOT NULL;
--> statement-breakpoint
ALTER TABLE "wallet_deposits" DROP CONSTRAINT IF EXISTS "wallet_deposits_part_check";
--> statement-breakpoint
ALTER TABLE "wallet_deposits" ADD CONSTRAINT "wallet_deposits_part_check" CHECK ("part" IN ('arrival', 'remainder'));
--> statement-breakpoint
DROP INDEX IF EXISTS "wallet_deposits_arrival_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_deposits_arrival_part_unique" ON "wallet_deposits" ("sui_digest", "wallet_address", "coin_type", "part");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_deposits_intent_idx" ON "wallet_deposits" ("org_id", "intent_id");
--> statement-breakpoint
ALTER TABLE "funding_intents" DROP CONSTRAINT IF EXISTS "funding_intents_status_check";
--> statement-breakpoint
ALTER TABLE "funding_intents" ADD CONSTRAINT "funding_intents_status_check" CHECK ("status" IN ('awaiting_funds', 'provider_pending', 'arriving', 'arrived', 'failed', 'expired', 'cancelled'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_deposit_sync" (
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "wallet_address" text NOT NULL,
  "usdc_type" text NOT NULL,
  "cursor" text,
  "net_usdc_minor" bigint DEFAULT 0 NOT NULL,
  "tx_count" integer DEFAULT 0 NOT NULL,
  "synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("org_id", "wallet_address"),
  CONSTRAINT "wallet_deposit_sync_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "funding_source_events" (
  "id" text PRIMARY KEY,
  "seq" bigserial NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "source_id" text NOT NULL REFERENCES "funding_sources"("id"),
  -- A user id, or `system` for a first-use check Splash ran on a deposit.
  "actor_user_id" text NOT NULL,
  "action" text NOT NULL,
  "evidence_sha256" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "funding_source_events_action_check" CHECK ("action" IN ('added', 'verified', 'revoked', 'first_use_passed', 'first_use_failed')),
  CONSTRAINT "funding_source_events_evidence_check" CHECK ("evidence_sha256" IS NULL OR "evidence_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funding_source_events_org_idx" ON "funding_source_events" ("org_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION funding_source_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'funding_source_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "funding_source_events_no_rewrite" ON "funding_source_events";
--> statement-breakpoint
CREATE TRIGGER "funding_source_events_no_rewrite" BEFORE UPDATE OR DELETE ON "funding_source_events"
  FOR EACH ROW EXECUTE FUNCTION funding_source_events_append_only();
--> statement-breakpoint
DROP INDEX IF EXISTS "funding_sources_org_fingerprint_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "funding_sources_org_fingerprint_live_unique" ON "funding_sources" ("org_id", "kind", "fingerprint") WHERE "status" <> 'revoked';
