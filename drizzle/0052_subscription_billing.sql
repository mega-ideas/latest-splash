-- Subscription billing (Amendment A1 §6), behind FEATURE_SUBSCRIPTION_BILLING,
-- which is OFF. Built and tested; nothing reads or writes these tables while
-- the flag is off, and no payment ever consults them.
--
-- 1. Plans, editable without code: a name, a price in USDC minor units, the
--    one interval (a calendar month, UTC), a term in calendar months, and an
--    optional lifetime cap.
-- 2. A business's subscription: the plan, the price it was signed at, the
--    business wallet that funds it, the finance multisig that may draw on it,
--    and the 0x2::allowance it lives in (the AllowanceCap stays with the
--    wallet). At most one live and one pending subscription per business.
-- 3. Pulls: at most ONE per business per calendar month (UTC), by the unique
--    index on (org, period). A failed pull may be tried again in the same
--    month on the same row; a succeeded one never.
-- 4. An invoice per pull, a receipt per succeeded pull, and the owners'
--    notice of a failed pull, each once.
-- 5. A new signing purpose, `subscription`: the wallet grants, changes or
--    revokes the billing allowance (lib/server/wallet-signing.ts).

CREATE TABLE IF NOT EXISTS "subscription_plans" (
  "id" text PRIMARY KEY NOT NULL CHECK ("id" ~ '^[A-Za-z0-9_-]{1,64}$'),
  "name" text NOT NULL CHECK (length("name") BETWEEN 1 AND 80),
  "price_minor" bigint NOT NULL CHECK ("price_minor" > 0),
  "interval" text DEFAULT 'calendar_month_utc' NOT NULL CHECK ("interval" = 'calendar_month_utc'),
  "term_months" integer DEFAULT 12 NOT NULL CHECK ("term_months" BETWEEN 1 AND 36),
  "lifetime_cap_minor" bigint CHECK ("lifetime_cap_minor" IS NULL OR "lifetime_cap_minor" > 0),
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "plan_id" text NOT NULL REFERENCES "subscription_plans"("id"),
  -- pending (the wallet has not signed yet) | active | grace (a pull failed)
  -- | lapsed (grace ran out) | cancelled | replaced (a plan change) | ended
  -- (the term ran out) | abandoned (the signing request expired or failed)
  "status" text NOT NULL CHECK ("status" IN ('pending', 'active', 'grace', 'lapsed', 'cancelled', 'replaced', 'ended', 'abandoned')),
  "price_minor" bigint NOT NULL CHECK ("price_minor" > 0),
  "lifetime_cap_minor" bigint,
  "wallet" text NOT NULL CHECK ("wallet" ~ '^0x[0-9a-f]{64}$'),
  "finance_address" text NOT NULL CHECK ("finance_address" ~ '^0x[0-9a-f]{64}$'),
  "allowance_name" text NOT NULL,
  "allowance_id" text,
  "allowance_cap_id" text,
  "term_start" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "grace_until" timestamp with time zone,
  "signing_request_id" text,
  "cancel_request_id" text,
  "replaces_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "subscriptions_finance_not_wallet" CHECK ("finance_address" <> "wallet"),
  CONSTRAINT "subscriptions_term_check" CHECK ("expires_at" > "term_start"),
  CONSTRAINT "subscriptions_live_has_allowance" CHECK ("status" NOT IN ('active', 'grace', 'lapsed') OR ("allowance_id" IS NOT NULL AND "allowance_cap_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_one_live_per_org" ON "subscriptions" ("org_id") WHERE "status" IN ('active', 'grace', 'lapsed');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_one_pending_per_org" ON "subscriptions" ("org_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_allowance_unique" ON "subscriptions" ("allowance_id") WHERE "allowance_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_pulls" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "subscription_id" text NOT NULL REFERENCES "subscriptions"("id"),
  -- The calendar month (UTC) this pull bills: 2026-11.
  "period" text NOT NULL CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  -- awaiting_signature (bytes built for the finance multisig) | submitted |
  -- succeeded | failed
  "status" text NOT NULL CHECK ("status" IN ('awaiting_signature', 'submitted', 'succeeded', 'failed')),
  "tx_bytes" text NOT NULL,
  "tx_digest" text NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL CHECK ("attempts" > 0),
  "failure_reason" text,
  "succeeded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- At most one pull per business per calendar month.
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_pulls_org_period_unique" ON "subscription_pulls" ("org_id", "period");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_pulls_digest_unique" ON "subscription_pulls" ("tx_digest");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_invoices" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "pull_id" text NOT NULL REFERENCES "subscription_pulls"("id"),
  "number" text NOT NULL,
  "period" text NOT NULL,
  "plan_name" text NOT NULL,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  "issued_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_invoices_pull_unique" ON "subscription_invoices" ("pull_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_invoices_number_unique" ON "subscription_invoices" ("number");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_receipts" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "pull_id" text NOT NULL REFERENCES "subscription_pulls"("id"),
  "invoice_id" text NOT NULL REFERENCES "subscription_invoices"("id"),
  "sui_digest" text NOT NULL,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  "paid_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_receipts_pull_unique" ON "subscription_receipts" ("pull_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_receipts_digest_unique" ON "subscription_receipts" ("sui_digest");
--> statement-breakpoint
-- An owner told that a pull failed (and the subscription is in grace), once
-- per pull and owner. Claimed as `sending` before the email is sent.
CREATE TABLE IF NOT EXISTS "subscription_notices" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "pull_id" text NOT NULL REFERENCES "subscription_pulls"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('pull_failed')),
  "status" text NOT NULL CHECK ("status" IN ('sending', 'sent', 'failed')),
  "attempts" integer DEFAULT 1 NOT NULL CHECK ("attempts" > 0),
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_notices_pull_user_kind_unique" ON "subscription_notices" ("pull_id", "user_id", "kind");
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" DROP CONSTRAINT IF EXISTS "wallet_signing_requests_purpose_check";
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" ADD CONSTRAINT "wallet_signing_requests_purpose_check" CHECK ("purpose" IN ('nominate_wallet', 'register_wallet', 'rotate_wallet', 'confirm_wallet_rotation', 'cancel_wallet_rotation', 'wallet_membership', 'wallet_payment', 'migration_transfer', 'rotation_transfer', 'spend_policy', 'spend_rule', 'spend_approval', 'withdrawal', 'partner_test_deposit', 'partner_payout', 'subscription'));
