-- Business Splash Wallet signature collection, second pass (v2 §4.1 review).
--
-- 1. A submission whose outcome the server does not know. After the
--    combined signature goes to the network, a timeout, a crash or a redeploy
--    can leave the server not knowing whether the transaction landed. Such a
--    request is now `unknown`, keeps its digest, holds no partial signature,
--    and keeps its dedupe key, so nothing like it can be asked for until the
--    cron has read the digest on chain (executed or failed) or the bytes'
--    ValidDuring window has passed, after which they can never land.
--    `claimed_at` is when a submission was claimed: a request still
--    `submitting` a few minutes after that is reconciled the same way.
-- 2. A signer can decline a request without closing it for everybody
--    (`declined_at`). Only the person who asked can cancel it.
-- 3. A rotation is followed by the old wallet moving its USDC to the new
--    one (`rotation_transfer`).
-- 4. A single-signer wallet with more than one owner needs every other
--    owner's recorded consent (`wallet_single_signer_consents`).

ALTER TABLE "wallet_signing_requests" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" DROP CONSTRAINT IF EXISTS "wallet_signing_requests_status_check";
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" ADD CONSTRAINT "wallet_signing_requests_status_check" CHECK ("status" IN ('collecting', 'submitting', 'unknown', 'executed', 'failed', 'expired', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" DROP CONSTRAINT IF EXISTS "wallet_signing_requests_purpose_check";
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" ADD CONSTRAINT "wallet_signing_requests_purpose_check" CHECK ("purpose" IN ('nominate_wallet', 'register_wallet', 'rotate_wallet', 'confirm_wallet_rotation', 'cancel_wallet_rotation', 'wallet_membership', 'wallet_payment', 'migration_transfer', 'rotation_transfer'));
--> statement-breakpoint
DROP INDEX IF EXISTS "wallet_signing_requests_open_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_signing_requests_open_unique" ON "wallet_signing_requests" ("org_id", "dedupe_key") WHERE "status" IN ('collecting', 'submitting', 'unknown');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_signing_requests_in_flight_idx" ON "wallet_signing_requests" ("status", "claimed_at") WHERE "status" IN ('submitting', 'unknown');
--> statement-breakpoint
ALTER TABLE "wallet_signing_signers" ADD COLUMN IF NOT EXISTS "declined_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "wallet_signing_signers" ADD CONSTRAINT "wallet_signing_signers_sign_or_decline" CHECK ("signed_at" IS NULL OR "declined_at" IS NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_single_signer_consents" (
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- The single-signer wallet address the owner agreed to: it is derived from
  -- every member's key and the threshold, so a consent covers exactly one
  -- member set.
  "wallet_address" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("org_id", "user_id", "wallet_address")
);
