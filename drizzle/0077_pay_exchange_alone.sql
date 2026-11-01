-- Staff may pay an exchange account alone, when an owner allows it (v2 Phase 3).
--
-- 1. wallet_member_access gains a third kind, `pay_exchange_alone`, beside
--    `add_funds` and `withdraw`: an owner's switch, per person. It is off for
--    everyone, and nothing here gives it to anyone (no backfill). An owner
--    turns it on or off at any time with no waiting period; each change is a
--    `member_access_granted` / `member_access_revoked` line on the trail
--    (wallet_authority_events, unchanged).
--
-- 2. wallet_transfer_disclosures: the message a staff member read and
--    confirmed before paying an exchange account alone. The exact payload (and
--    the exact text it was hashed from) is kept with the payment, bound to the
--    intent id (`intent_id`, `payment_ref`), the transfer and the signing
--    request. The signing layer reads it back before every signature and
--    refuses a payment whose recorded message does not match the bytes. A row
--    is never rewritten: a trigger refuses UPDATE. (DELETE is left to the
--    cascade from wallet_transfers, which removes a payment that was never
--    built.)
ALTER TABLE "wallet_member_access" DROP CONSTRAINT IF EXISTS "wallet_member_access_kind";
--> statement-breakpoint
ALTER TABLE "wallet_member_access" ADD CONSTRAINT "wallet_member_access_kind" CHECK ("access" IN ('add_funds', 'withdraw', 'pay_exchange_alone'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_transfer_disclosures" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "transfer_id" text NOT NULL REFERENCES "wallet_transfers"("id") ON DELETE CASCADE,
  -- The client's intent id (the Idempotency-Key) and the payment reference derived from it, as the chain and the Travel Rule row know it.
  "intent_id" text NOT NULL,
  "payment_ref" text NOT NULL,
  -- Set once the signing request exists; the gate looks the message up by it.
  "signing_request_id" text,
  "payload" jsonb NOT NULL,
  -- The exact text that was hashed, and its sha256: what the person confirmed.
  "canonical" text NOT NULL,
  "payload_hash" text NOT NULL,
  "confirmed_by" text NOT NULL,
  "confirmed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "wallet_transfer_disclosures_hash" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transfer_disclosures_transfer_unique" ON "wallet_transfer_disclosures" ("org_id", "transfer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transfer_disclosures_intent_unique" ON "wallet_transfer_disclosures" ("org_id", "intent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_transfer_disclosures_request_idx" ON "wallet_transfer_disclosures" ("org_id", "signing_request_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_transfer_disclosures_no_rewrite() RETURNS trigger AS $$
BEGIN
  -- The one allowed change is the signing request id, set once when the request is opened.
  IF NEW.signing_request_id IS DISTINCT FROM OLD.signing_request_id AND OLD.signing_request_id IS NULL
     AND NEW.id = OLD.id AND NEW.org_id = OLD.org_id AND NEW.transfer_id = OLD.transfer_id AND NEW.intent_id = OLD.intent_id
     AND NEW.payment_ref = OLD.payment_ref AND NEW.payload = OLD.payload AND NEW.canonical = OLD.canonical
     AND NEW.payload_hash = OLD.payload_hash AND NEW.confirmed_by = OLD.confirmed_by AND NEW.confirmed_at = OLD.confirmed_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'wallet_transfer_disclosures is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "wallet_transfer_disclosures_no_rewrite" ON "wallet_transfer_disclosures";
--> statement-breakpoint
CREATE TRIGGER "wallet_transfer_disclosures_no_rewrite" BEFORE UPDATE ON "wallet_transfer_disclosures"
  FOR EACH ROW EXECUTE FUNCTION wallet_transfer_disclosures_no_rewrite();
