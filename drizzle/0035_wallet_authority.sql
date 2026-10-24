-- Who may do what with the Business Splash Wallet, beyond the multisig itself
-- (v2 §4.1, Sky's answers of 25 Oct).
--
-- 1. `wallet_authority_events`: an append-only audit trail of every grant,
--    revocation, sign-off and approval ask. A trigger refuses UPDATE and
--    DELETE, so the trail cannot be rewritten by the application.
-- 2. `wallet_persons_in_charge`: the person in charge, an off-chain role an
--    owner appoints and revokes, per business. With the owners, the highest
--    authority: they may sign off a staff member's migration of their own
--    USDC into the business wallet.
-- 3. `wallet_migration_signoffs`: that sign-off. The highest authority's
--    passkey signs a statement naming the business, the member, the wallet
--    the USDC leaves and the business wallet it goes to, with a nonce and an
--    expiry. The signature is public data (a personal-message signature).
-- 4. `wallet_approval_asks`: a staff member (or anyone but a viewer) asks
--    the owners to approve one of their open payments, for example one over
--    their spending rule. An owner turns it into the quorum's signing request.

CREATE TABLE IF NOT EXISTS "wallet_authority_events" (
  "id" text PRIMARY KEY,
  -- The order events happened in, even within one clock tick.
  "seq" bigserial NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "actor_user_id" text NOT NULL REFERENCES "users"("id"),
  "action" text NOT NULL,
  "subject_user_id" text REFERENCES "users"("id"),
  "ref" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_authority_events_action_check" CHECK ("action" IN (
    'person_in_charge_appointed', 'person_in_charge_revoked',
    'migration_sign_off_prepared', 'migration_signed_off', 'migration_sign_off_used', 'migration_sign_off_voided',
    'approval_requested', 'approval_accepted', 'approval_declined', 'approval_withdrawn', 'approval_completed'
  ))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_authority_events_org_idx" ON "wallet_authority_events" ("org_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_authority_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_authority_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "wallet_authority_events_no_rewrite" ON "wallet_authority_events";
--> statement-breakpoint
CREATE TRIGGER "wallet_authority_events_no_rewrite" BEFORE UPDATE OR DELETE ON "wallet_authority_events"
  FOR EACH ROW EXECUTE FUNCTION wallet_authority_events_append_only();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_persons_in_charge" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "granted_by" text NOT NULL REFERENCES "users"("id"),
  "granted_at" timestamp with time zone NOT NULL,
  "revoked_by" text REFERENCES "users"("id"),
  "revoked_at" timestamp with time zone,
  CONSTRAINT "wallet_persons_in_charge_revocation" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_persons_in_charge_active_unique" ON "wallet_persons_in_charge" ("org_id", "user_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_migration_signoffs" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "member_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "from_address" text NOT NULL,
  "to_wallet" text NOT NULL,
  "signed_by" text NOT NULL REFERENCES "users"("id"),
  "message" text NOT NULL,
  "nonce" text NOT NULL UNIQUE,
  "signature" text,
  "signer_address" text,
  "signed_at" timestamp with time zone,
  "voided_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_migration_signoffs_member_idx" ON "wallet_migration_signoffs" ("org_id", "member_user_id", "from_address");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_approval_asks" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "intent_id" text NOT NULL,
  "requested_by" text NOT NULL REFERENCES "users"("id"),
  -- The intent as the chain had it when the ask was made: payee, principal,
  -- kind, rate, expiry. What owners are shown, never what the client sent.
  "intent" jsonb NOT NULL,
  "note" text,
  "content_hash" text NOT NULL,
  "walrus_blob_id" text NOT NULL,
  "status" text NOT NULL,
  "signing_request_id" text REFERENCES "wallet_signing_requests"("id"),
  "decided_by" text REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "decision_note" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_approval_asks_status_check" CHECK ("status" IN ('open', 'signing', 'approved', 'declined', 'withdrawn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_approval_asks_open_unique" ON "wallet_approval_asks" ("org_id", "intent_id") WHERE "status" IN ('open', 'signing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_approval_asks_org_idx" ON "wallet_approval_asks" ("org_id", "status");
