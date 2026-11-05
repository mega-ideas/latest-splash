-- Withdrawals to the business's own bank (v2 §4.4) over the payout-partner
-- interface (§4.5). MYR: business wallet → Hata → Fiuu → the business's bank.
-- Splash never receives the MYR, and no Splash address is on the path.
--
-- 1. `withdrawal_destinations`: the business's own bank accounts. Stored only
--    after the holder name, as given and as the partner's name enquiry returns
--    it from the bank, both match the business's registered name. The account
--    number and the beneficiary salt are sealed (AES-256-GCM under
--    WITHDRAWAL_ACCOUNT_KEY, bound to the org and row); the fingerprint is the
--    funding sources' keyed HMAC. One live row per account per partner.
-- 2. `partner_deposit_addresses`: the business's fixed deposit address with a
--    partner. Verified once, by a test deposit the partner confirms. One live
--    row per business per partner, and one business per address.
-- 3. `withdrawals`: one withdrawal; idempotent by the client's key, by the
--    intent id (the partner's idempotency key) and by the partner's reference.
-- 4. `withdrawal_events`: an append-only trail. A trigger refuses UPDATE and
--    DELETE.
-- 5. `payout_partner_events`: each partner webhook, once.
-- 6. Two new signing purposes: `withdrawal` (the bank payout) and
--    `partner_test_deposit` (the transfer that verifies the address).

ALTER TABLE "wallet_signing_requests" DROP CONSTRAINT IF EXISTS "wallet_signing_requests_purpose_check";
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" ADD CONSTRAINT "wallet_signing_requests_purpose_check" CHECK ("purpose" IN ('nominate_wallet', 'register_wallet', 'rotate_wallet', 'confirm_wallet_rotation', 'cancel_wallet_rotation', 'wallet_membership', 'wallet_payment', 'migration_transfer', 'rotation_transfer', 'spend_policy', 'spend_rule', 'spend_approval', 'withdrawal', 'partner_test_deposit'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "withdrawal_destinations" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "partner" text NOT NULL,
  "country" text NOT NULL,
  "currency" text NOT NULL,
  "bank_code" text NOT NULL,
  "holder_name" text NOT NULL,
  "bank_holder_name" text NOT NULL,
  "name_check_ref" text NOT NULL,
  "fingerprint" text NOT NULL,
  "last4" text NOT NULL,
  "account_sealed" text NOT NULL,
  "beneficiary_salt_sealed" text NOT NULL,
  "beneficiary_ref" text NOT NULL,
  "label" text NOT NULL,
  "status" text NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "verified_by" text NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "withdrawal_destinations_status_check" CHECK ("status" IN ('verified', 'revoked')),
  CONSTRAINT "withdrawal_destinations_ref_check" CHECK ("beneficiary_ref" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "withdrawal_destinations_last4_check" CHECK ("last4" ~ '^[A-Z0-9]{4}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawal_destinations_live_unique" ON "withdrawal_destinations" ("org_id", "partner", "fingerprint") WHERE "status" <> 'revoked';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawal_destinations_org_idx" ON "withdrawal_destinations" ("org_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "partner_deposit_addresses" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "partner" text NOT NULL,
  "address" text NOT NULL,
  "account_ref" text NOT NULL,
  "status" text NOT NULL,
  "test_amount_minor" bigint NOT NULL,
  "test_request_id" text,
  "test_digest" text,
  "test_wallet" text,
  "verified_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_deposit_addresses_status_check" CHECK ("status" IN ('pending_test', 'test_requested', 'test_sent', 'verified', 'revoked')),
  CONSTRAINT "partner_deposit_addresses_address_check" CHECK ("address" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "partner_deposit_addresses_amount_check" CHECK ("test_amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "partner_deposit_addresses_live_unique" ON "partner_deposit_addresses" ("org_id", "partner") WHERE "status" <> 'revoked';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "partner_deposit_addresses_address_unique" ON "partner_deposit_addresses" ("partner", "address") WHERE "status" <> 'revoked';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "partner_deposit_addresses_test_digest_unique" ON "partner_deposit_addresses" ("test_digest") WHERE "test_digest" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "withdrawals" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "client_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "partner" text NOT NULL,
  "destination_id" text NOT NULL REFERENCES "withdrawal_destinations"("id"),
  "deposit_address_id" text NOT NULL REFERENCES "partner_deposit_addresses"("id"),
  "deposit_address" text NOT NULL,
  "wallet_address" text NOT NULL,
  "payment_ref" text NOT NULL,
  "intent_id" text NOT NULL,
  "beneficiary_ref" text NOT NULL,
  "commitment_salt_sealed" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "max_fee_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "rate_micro" bigint NOT NULL,
  "receive_minor" bigint NOT NULL,
  "quote" jsonb NOT NULL,
  "quote_ref" text NOT NULL,
  "quote_expires_at" timestamp with time zone NOT NULL,
  "partner_ref" text,
  "signing_request_id" text,
  "sui_digest" text,
  "settlement_posted_at" timestamp with time zone,
  "bank_ref" text,
  "return_digest" text,
  "status" text NOT NULL,
  "failure" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "withdrawals_status_check" CHECK ("status" IN ('preparing', 'awaiting_signatures', 'sent', 'partner_received', 'paid_out', 'failed', 'returned', 'cancelled')),
  CONSTRAINT "withdrawals_amount_check" CHECK ("amount_minor" > 0 AND "max_fee_minor" >= 0 AND "receive_minor" >= 0 AND "rate_micro" > 0),
  CONSTRAINT "withdrawals_intent_check" CHECK ("intent_id" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "withdrawals_ref_check" CHECK ("payment_ref" ~ '^[0-9a-f]{64}$' AND "beneficiary_ref" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_client_key_unique" ON "withdrawals" ("org_id", "client_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_intent_unique" ON "withdrawals" ("intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_payment_ref_unique" ON "withdrawals" ("payment_ref");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_partner_ref_unique" ON "withdrawals" ("partner", "partner_ref") WHERE "partner_ref" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_sui_digest_unique" ON "withdrawals" ("sui_digest") WHERE "sui_digest" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_org_idx" ON "withdrawals" ("org_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "withdrawal_events" (
  "id" text PRIMARY KEY,
  "seq" bigserial NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "subject" text NOT NULL,
  "subject_id" text,
  -- A user id, `system`, or `partner:<id>` for a verified partner webhook.
  "actor" text NOT NULL,
  "action" text NOT NULL,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "withdrawal_events_subject_check" CHECK ("subject" IN ('destination', 'deposit_address', 'withdrawal'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawal_events_org_idx" ON "withdrawal_events" ("org_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION withdrawal_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'withdrawal_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "withdrawal_events_no_rewrite" ON "withdrawal_events";
--> statement-breakpoint
CREATE TRIGGER "withdrawal_events_no_rewrite" BEFORE UPDATE OR DELETE ON "withdrawal_events"
  FOR EACH ROW EXECUTE FUNCTION withdrawal_events_append_only();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payout_partner_events" (
  "partner" text NOT NULL,
  "event_id" text NOT NULL,
  "org_id" text REFERENCES "organizations"("id"),
  "subject_id" text,
  "status" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("partner", "event_id")
);
