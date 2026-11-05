-- The audit proof for a payment always says who started it, who approved it and who declined it
-- (v2 Phase 3, p3-disclosure; Sky's rule).
--
-- The sealed evidence record of a payment (Seal-encrypted, on Walrus; its hash and blob id are
-- anchored on Sui with the payment) is made when the payment is built. Until now it held the payer,
-- the payee, the amount, the fee bound and the reference, but not who started the payment and no
-- approver or decliner. It now also holds the actor, the role, the time, the route and the rule,
-- inside the encrypted record, and each later signature, decline or answer to an ask is one more
-- sealed record bound to the first by its hash. The name-sharing switches (0084) never reach any of
-- it.
--
-- 1. wallet_transfers.record_hash, record_blob_id: the hash (hex, sha256 of the plain record) and the
--    Walrus blob id (hex) of the payment's own record, so a decision record can name it. Nullable:
--    nothing existing is changed, and a payment made before this has none.
--
-- 2. payment_trail_events: one row per decision. Internal ids, times and hashes ONLY (no name is stored
--    in plain text); the name and title are inside the sealed record. One row per payment, person and
--    kind, so a replay makes no second row. A trigger refuses any rewrite; the one change allowed is
--    sealing a row, once (content_hash, walrus_blob_id and sealed_at from null to a value). DELETE
--    follows the payment (ON DELETE CASCADE from wallet_transfers).
ALTER TABLE "wallet_transfers" ADD COLUMN IF NOT EXISTS "record_hash" text;
--> statement-breakpoint
ALTER TABLE "wallet_transfers" ADD COLUMN IF NOT EXISTS "record_blob_id" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_trail_events" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "transfer_id" text NOT NULL REFERENCES "wallet_transfers"("id") ON DELETE CASCADE,
  "signing_request_id" text,
  "ask_id" text,
  "user_id" text NOT NULL,
  "role" text NOT NULL,
  "kind" text NOT NULL,
  "decided_at" timestamp with time zone NOT NULL,
  "base_hash" text,
  "content_hash" text,
  "walrus_blob_id" text,
  "sealed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "payment_trail_events_kind" CHECK ("kind" IN ('signed', 'declined', 'ask_accepted', 'ask_declined')),
  CONSTRAINT "payment_trail_events_role" CHECK ("role" IN ('owner', 'approver', 'staff', 'viewer')),
  CONSTRAINT "payment_trail_events_hashes" CHECK (
    ("base_hash" IS NULL OR "base_hash" ~ '^[0-9a-f]{64}$') AND ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_trail_events_decision_unique" ON "payment_trail_events" ("transfer_id", "user_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_trail_events_org_transfer_idx" ON "payment_trail_events" ("org_id", "transfer_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_trail_events_no_rewrite() RETURNS trigger AS $$
BEGIN
  -- The one allowed change: sealing a row that has not been sealed (the hash, the blob and the time, each from null).
  IF OLD.content_hash IS NULL AND OLD.walrus_blob_id IS NULL AND OLD.sealed_at IS NULL
     AND NEW.content_hash IS NOT NULL AND NEW.walrus_blob_id IS NOT NULL AND NEW.sealed_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.org_id = OLD.org_id AND NEW.transfer_id = OLD.transfer_id
     AND NEW.signing_request_id IS NOT DISTINCT FROM OLD.signing_request_id AND NEW.ask_id IS NOT DISTINCT FROM OLD.ask_id
     AND NEW.user_id = OLD.user_id AND NEW.role = OLD.role AND NEW.kind = OLD.kind
     AND NEW.decided_at = OLD.decided_at AND NEW.base_hash IS NOT DISTINCT FROM OLD.base_hash AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payment_trail_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_trail_events_no_rewrite" ON "payment_trail_events";
--> statement-breakpoint
CREATE TRIGGER "payment_trail_events_no_rewrite" BEFORE UPDATE ON "payment_trail_events" FOR EACH ROW EXECUTE FUNCTION payment_trail_events_no_rewrite();
