-- Transfer (v2 brief 5.4): the payment a person starts, its receipt and its documents.
--
-- wallet_transfers: one row per payment started from Transfer to a Splash
-- business or a saved wallet or exchange recipient. The client's key (the
-- intent id) is unique per business, so a retry, a double click or two racing
-- requests make one payment. It names the signing request the owners sign, or
-- the ask the owners were sent, and keeps what the receipt shows about the
-- payee (a name, a masked address) so the receipt never reads another table
-- for it. No account number, key or signature is kept here.
--
-- payment_receipt_shares: a link a person makes to share a receipt. Only the
-- SHA-256 of the token is kept; the link can expire and be revoked, and it
-- opens one payment's receipt and nothing else.
--
-- payment_einvoices: the self-billed MyInvois file made for a payment, once
-- per payment, with its SHA-256 so a file filed with LHDN can be told from a
-- later one.
CREATE TABLE IF NOT EXISTS "wallet_transfers" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "client_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "payment_ref" text NOT NULL,
  "route" text NOT NULL,
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
  "signing_request_id" text REFERENCES "wallet_signing_requests"("id"),
  "ask_id" text REFERENCES "wallet_approval_asks"("id"),
  "requested_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_transfers_route_check" CHECK ("route" IN ('owners_sign', 'asked_owners')),
  CONSTRAINT "wallet_transfers_payee_kind_check" CHECK ("payee_kind" IN ('splash_business', 'exchange', 'self_custody')),
  CONSTRAINT "wallet_transfers_amount_check" CHECK ("amount_minor" > 0 AND "max_fee_minor" >= 0),
  CONSTRAINT "wallet_transfers_payment_ref_check" CHECK ("payment_ref" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transfers_org_key_unique" ON "wallet_transfers" ("org_id", "client_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transfers_org_ref_unique" ON "wallet_transfers" ("org_id", "payment_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_transfers_org_created_idx" ON "wallet_transfers" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_transfers_request_idx" ON "wallet_transfers" ("signing_request_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_receipt_shares" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "payment_ref" text NOT NULL,
  "token_hash" text NOT NULL,
  "created_by" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_receipt_shares_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_receipt_shares_hash_unique" ON "payment_receipt_shares" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_receipt_shares_org_ref_idx" ON "payment_receipt_shares" ("org_id", "payment_ref");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_einvoices" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "payment_ref" text NOT NULL,
  "document" jsonb NOT NULL,
  "sha256" text NOT NULL,
  "guideline" text NOT NULL,
  "generated_by" text NOT NULL,
  "generated_at" timestamp with time zone NOT NULL,
  "history" jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT "payment_einvoices_hash_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_einvoices_org_ref_unique" ON "payment_einvoices" ("org_id", "payment_ref");
