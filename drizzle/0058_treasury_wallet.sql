-- Treasury in the business's own wallet (v2 D9, brief 5.7).
--
-- Numbered 0055 so it lands after Phase 2's 0033-0054 (v2/phase2-backend)
-- now that the branches meet, instead of colliding with them.
--
-- `treasury_wallet_orders`: one swap (USDC to USDY) or redemption (USDY to
-- USDC) from the business wallet, handed to the wallet's signers. Splash
-- signs nothing: an order is the request the owners sign in their wallet.
-- The intent id is the client's idempotency key: unique per org, so a retried
-- or double-clicked request is one order, and the same id with a different
-- amount is refused (request_hash). Status only moves forward from
-- `awaiting_signatures`; a closed order never reopens.
CREATE TABLE IF NOT EXISTS "treasury_wallet_orders" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "intent_id" text NOT NULL,
  "direction" text NOT NULL CHECK ("direction" IN ('swap', 'redeem')),
  "amount_in_minor" bigint NOT NULL CHECK ("amount_in_minor" > 0),
  "min_out_minor" bigint NOT NULL CHECK ("min_out_minor" > 0),
  "quoted_out_minor" bigint NOT NULL CHECK ("quoted_out_minor" > 0),
  "price_micros" bigint NOT NULL CHECK ("price_micros" > 0),
  "request_hash" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('awaiting_signatures', 'executed', 'failed', 'expired', 'cancelled')),
  "sandbox" boolean NOT NULL,
  "provider_ref" text,
  "tx_digest" text,
  "requested_by" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CHECK ("min_out_minor" <= "quoted_out_minor")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_wallet_orders_org_intent_unique" ON "treasury_wallet_orders" ("org_id", "intent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_wallet_orders_org_created_idx" ON "treasury_wallet_orders" ("org_id", "created_at");
--> statement-breakpoint
-- `treasury_fund_referrals`: one row per business. The eligibility answers an
-- owner gave and what they mean, when the referral link was opened, and the
-- business's account reference at the fund manager once linked. A reference
-- belongs to one business: unique, so no business can link (and read) a
-- holding another business already linked.
CREATE TABLE IF NOT EXISTS "treasury_fund_referrals" (
  "org_id" text PRIMARY KEY NOT NULL REFERENCES "organizations"("id"),
  "answers" jsonb NOT NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('eligible', 'not_eligible')),
  "category" text CHECK ("category" IS NULL OR "category" IN ('regulated_institution', 'net_assets', 'wholly_owned')),
  "assessed_by" text NOT NULL,
  "assessed_at" timestamp with time zone NOT NULL,
  "referral_opened_at" timestamp with time zone,
  "linked_reference" text,
  "linked_by" text,
  "linked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CHECK (("outcome" = 'eligible') = ("category" IS NOT NULL)),
  CHECK ("linked_reference" IS NULL OR "outcome" = 'eligible')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_fund_referrals_linked_reference_unique" ON "treasury_fund_referrals" ("linked_reference") WHERE "linked_reference" IS NOT NULL;
