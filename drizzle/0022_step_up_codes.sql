-- Step-up approvals (lib/server/step-up.ts), in the workspace's chosen style:
--   WHATSAPP_PASSKEY  a 6-digit code WhatsApp'd to a VERIFIED number, typed
--                     back into Splash by that person, then confirmed with
--                     their passkey. Only an HMAC of the code is stored.
--   CLICK             an approver clicks Approve in Splash (maker-checker when
--                     the workspace requires a second person).
-- Either way the approval is bound by digest to exactly what was approved.
CREATE TABLE "step_up_codes" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "method" text NOT NULL,
  "approver_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "requested_by" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL,
  "subject_id" text NOT NULL,
  "subject_digest" text NOT NULL,
  "summary" text NOT NULL,
  "code_hash" text,
  "sent_to" text,
  "delivered" boolean DEFAULT false NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "code_verified_at" timestamp with time zone,
  "passkey_credential_id" text REFERENCES "passkey_credentials"("id"),
  "verified_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "superseded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "step_up_codes_purpose_check" CHECK ("purpose" IN ('STABLECOIN_TRANSFER', 'FIAT_TRANSFER', 'BATCH_PAYOUT', 'SETTINGS_CHANGE', 'PROFILE_CHANGE')),
  CONSTRAINT "step_up_codes_method_check" CHECK (
    ("method" = 'CLICK' AND "code_hash" IS NULL)
    OR ("method" = 'WHATSAPP_PASSKEY' AND COALESCE(length("code_hash") = 64, false))
  ),
  CONSTRAINT "step_up_codes_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 5),
  CONSTRAINT "step_up_codes_digest_check" CHECK (length("subject_digest") = 64),
  -- WhatsApp approvals are complete only with the code AND the passkey.
  CONSTRAINT "step_up_codes_whatsapp_complete_check" CHECK (
    "verified_at" IS NULL
    OR "method" = 'CLICK'
    OR ("code_verified_at" IS NOT NULL AND "passkey_credential_id" IS NOT NULL)
  ),
  -- An approval is used only after it is given.
  CONSTRAINT "step_up_codes_consumed_after_verified_check" CHECK ("consumed_at" IS NULL OR "verified_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "step_up_codes_subject_idx" ON "step_up_codes" ("org_id", "purpose", "subject_id");
--> statement-breakpoint
-- Who asked for a wallet transfer: maker-checker needs to know, so that the
-- person who quoted cannot also be the second person who approves.
ALTER TABLE "stablecoin_outflows" ADD COLUMN "requested_by" text REFERENCES "users"("id");
