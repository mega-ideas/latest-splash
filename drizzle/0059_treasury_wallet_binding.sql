-- Treasury in the business's own wallet: the 5.7 review (v2 D9).
--
-- `treasury_wallet_orders` gains the wallet it is bound to. The server
-- resolves the business wallet (never the client) and records it as both the
-- source and the recipient: a swap's output goes back to the wallet it came
-- from, and to no other address (not the operator, not a sponsor). Both coin
-- types are recorded too, so the transaction the signers see can be checked
-- against the order. Orders made before this migration were sandbox only and
-- carry no wallet; they are removed, since none of them can be signed.
DELETE FROM "treasury_wallet_orders";
--> statement-breakpoint
ALTER TABLE "treasury_wallet_orders"
  ADD COLUMN "source_address" text NOT NULL CHECK ("source_address" ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN "recipient_address" text NOT NULL CHECK ("recipient_address" ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN "in_coin_type" text NOT NULL,
  ADD COLUMN "out_coin_type" text NOT NULL,
  ADD CONSTRAINT "treasury_wallet_orders_recipient_is_source" CHECK ("recipient_address" = "source_address"),
  ADD CONSTRAINT "treasury_wallet_orders_coin_types_differ" CHECK ("in_coin_type" <> "out_coin_type");
--> statement-breakpoint
-- The fund-manager referral keeps everything that happened to it: every
-- assessment an owner gave (who, when, the answers and what they meant),
-- every link the fund manager confirmed, and every release by support.
-- Rows are only ever inserted. The current row points at the latest
-- assessment.
CREATE TABLE IF NOT EXISTS "treasury_fund_referral_history" (
  "id" text PRIMARY KEY NOT NULL,
  -- The order things happened in, even within one millisecond.
  "seq" bigserial NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('assessed', 'linked', 'released')),
  "actor" text NOT NULL,
  "at" timestamp with time zone NOT NULL,
  "answers" jsonb,
  "outcome" text CHECK ("outcome" IS NULL OR "outcome" IN ('eligible', 'not_eligible')),
  "category" text CHECK ("category" IS NULL OR "category" IN ('regulated_institution', 'net_assets', 'wholly_owned')),
  "reference" text,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CHECK (("kind" = 'assessed') = ("answers" IS NOT NULL AND "outcome" IS NOT NULL)),
  CHECK ("kind" <> 'linked' OR "reference" IS NOT NULL),
  CHECK ("kind" <> 'released' OR ("reference" IS NOT NULL AND "reason" IS NOT NULL AND length("reason") > 0))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_fund_referral_history_org_seq_idx" ON "treasury_fund_referral_history" ("org_id", "seq");
--> statement-breakpoint
-- Earlier assessments become the first history row of each referral.
INSERT INTO "treasury_fund_referral_history" ("id", "org_id", "kind", "actor", "at", "answers", "outcome", "category")
  SELECT 'tfh_' || md5("org_id" || ':' || "assessed_at"::text), "org_id", 'assessed', "assessed_by", "assessed_at", "answers", "outcome", "category"
  FROM "treasury_fund_referrals";
--> statement-breakpoint
ALTER TABLE "treasury_fund_referrals"
  ADD COLUMN "latest_assessment_id" text REFERENCES "treasury_fund_referral_history"("id"),
  -- When the fund manager confirmed that the linked reference is this business's.
  ADD COLUMN "link_confirmed_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "treasury_fund_referrals" SET "latest_assessment_id" = 'tfh_' || md5("org_id" || ':' || "assessed_at"::text);
--> statement-breakpoint
-- A link stored without the fund manager's confirmation was only typed in;
-- it is dropped, and the business links again.
UPDATE "treasury_fund_referrals" SET "linked_reference" = NULL, "linked_by" = NULL, "linked_at" = NULL;
--> statement-breakpoint
ALTER TABLE "treasury_fund_referrals"
  ALTER COLUMN "latest_assessment_id" SET NOT NULL,
  ADD CONSTRAINT "treasury_fund_referrals_link_confirmed" CHECK ("linked_reference" IS NULL OR "link_confirmed_at" IS NOT NULL);
