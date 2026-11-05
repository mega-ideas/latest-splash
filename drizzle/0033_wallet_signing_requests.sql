-- Business Splash Wallet signature collection (v2 §4.1, review item B10).
--
-- A request is one transaction that a business wallet, its founder or one of
-- its members must sign: the exact BCS bytes, their digest, and what they do
-- as decoded from those bytes on the server (never from client state). Each
-- signer signs on their own device; the server checks each partial signature
-- against the stored bytes and the signer's own key, and combines them once
-- the signed weight reaches the threshold.
--
-- Partial signatures are kept only while a request is collecting. Executing,
-- failing, expiring or cancelling a request clears every one of them
-- (`signature` set to NULL); only a SHA-256 of each stays, as evidence of who
-- signed what. Expired requests are swept by /api/cron/wallet-signing. Nothing
-- here is ever logged.

CREATE TABLE IF NOT EXISTS "wallet_signing_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "purpose" text NOT NULL CHECK ("purpose" IN ('nominate_wallet', 'register_wallet', 'rotate_wallet', 'confirm_wallet_rotation', 'cancel_wallet_rotation', 'wallet_membership', 'wallet_payment', 'migration_transfer')),
  -- One open request per org and key (say, one wallet registration at a time).
  "dedupe_key" text NOT NULL,
  "sender_address" text NOT NULL,
  "signer_kind" text NOT NULL CHECK ("signer_kind" IN ('single', 'multisig')),
  "multisig_public_key" text,
  "threshold" integer NOT NULL CHECK ("threshold" > 0),
  "gas_mode" text NOT NULL CHECK ("gas_mode" IN ('sponsored', 'gasless')),
  "tx_bytes" text NOT NULL,
  "tx_digest" text NOT NULL,
  "bytes_hash" text NOT NULL,
  "summary" jsonb NOT NULL,
  -- What to ask for once this one executes (the founder's nomination is
  -- followed by the wallet's registration): public keys and weights only.
  "next_step" jsonb,
  "status" text NOT NULL CHECK ("status" IN ('collecting', 'submitting', 'executed', 'failed', 'expired', 'cancelled')),
  "requested_by" text NOT NULL REFERENCES "users"("id"),
  "expires_at" timestamp with time zone NOT NULL,
  "executed_digest" text,
  "error" text,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CHECK (("signer_kind" = 'multisig') = ("multisig_public_key" IS NOT NULL))
);
--> statement-breakpoint
-- A digest is one transaction: the same bytes can never be asked for twice.
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_signing_requests_digest_unique" ON "wallet_signing_requests" ("tx_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_signing_requests_open_unique" ON "wallet_signing_requests" ("org_id", "dedupe_key") WHERE "status" IN ('collecting', 'submitting');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_signing_requests_org_status_idx" ON "wallet_signing_requests" ("org_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_signing_requests_expires_idx" ON "wallet_signing_requests" ("expires_at") WHERE "status" = 'collecting';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_signing_signers" (
  "request_id" text NOT NULL REFERENCES "wallet_signing_requests"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "address" text NOT NULL,
  -- flag || public key, base64: the key the signature must verify under.
  "public_key" text NOT NULL,
  "weight" integer NOT NULL CHECK ("weight" BETWEEN 1 AND 255),
  "signature" text,
  "signature_sha256" text,
  "signed_at" timestamp with time zone,
  "notified_at" timestamp with time zone,
  "notified_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("request_id", "user_id"),
  CHECK ("signature" IS NULL OR "signed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_signing_signers_request_address_unique" ON "wallet_signing_signers" ("request_id", "address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_signing_signers_user_idx" ON "wallet_signing_signers" ("user_id", "org_id");
