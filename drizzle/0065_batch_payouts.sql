-- Batch payouts (v2 Phase 3, brief 5.6): up to a set number of payments to the
-- business's saved recipients, in one transaction the owners sign once.
--
-- wallet_batches: one row per batch. The client's key (the batch's intent id)
-- is unique per business, so a retry, a double click or two racing requests
-- make one batch. `request_hash` is what the batch IS (who, how much, the
-- reference), so the same key with another sheet is refused. It names the
-- signing request the owners sign once an owner has started the signatures; a
-- batch a staff member prepared waits with no request until an owner does.
-- No account number, key or signature is kept here.
--
-- wallet_batch_rows: one row per payment, in the order of the sheet. Each
-- keeps what its receipt shows about the payee (a name, a masked address) and
-- the payment reference its intent is claimed under on chain, unique per
-- business, so no row is ever paid twice even by a second batch.
--
-- The signing purpose `wallet_batch` is added to the list the table allows.
CREATE TABLE IF NOT EXISTS "wallet_batches" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "client_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "label" text,
  "row_count" integer NOT NULL,
  "total_amount_minor" bigint NOT NULL,
  "total_max_fee_minor" bigint NOT NULL,
  "signing_request_id" text REFERENCES "wallet_signing_requests"("id"),
  "requested_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_batches_rows_check" CHECK ("row_count" >= 1 AND "row_count" <= 20),
  CONSTRAINT "wallet_batches_amount_check" CHECK ("total_amount_minor" > 0 AND "total_max_fee_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_batches_org_key_unique" ON "wallet_batches" ("org_id", "client_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_batches_org_created_idx" ON "wallet_batches" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_batches_request_idx" ON "wallet_batches" ("signing_request_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_batch_rows" (
  "id" text PRIMARY KEY NOT NULL,
  "batch_id" text NOT NULL REFERENCES "wallet_batches"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "position" integer NOT NULL,
  "payment_ref" text NOT NULL,
  "payee_kind" text NOT NULL,
  "recipient_id" text,
  "business_id" text,
  "payee_name" text NOT NULL,
  "payee_masked" text,
  "payee_country" text,
  "address" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "max_fee_minor" bigint NOT NULL,
  "fee_kind" integer NOT NULL,
  "reference" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_batch_rows_payee_kind_check" CHECK ("payee_kind" IN ('splash_business', 'self_custody')),
  CONSTRAINT "wallet_batch_rows_amount_check" CHECK ("amount_minor" > 0 AND "max_fee_minor" >= 0),
  CONSTRAINT "wallet_batch_rows_payment_ref_check" CHECK ("payment_ref" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_batch_rows_batch_position_unique" ON "wallet_batch_rows" ("batch_id", "position");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_batch_rows_org_ref_unique" ON "wallet_batch_rows" ("org_id", "payment_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_batch_rows_org_idx" ON "wallet_batch_rows" ("org_id");
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" DROP CONSTRAINT IF EXISTS "wallet_signing_requests_purpose_check";
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" ADD CONSTRAINT "wallet_signing_requests_purpose_check" CHECK ("purpose" IN ('nominate_wallet', 'register_wallet', 'rotate_wallet', 'confirm_wallet_rotation', 'cancel_wallet_rotation', 'wallet_membership', 'wallet_payment', 'wallet_batch', 'migration_transfer', 'rotation_transfer', 'spend_policy', 'spend_rule', 'spend_approval', 'withdrawal', 'partner_test_deposit', 'partner_payout', 'subscription'));
