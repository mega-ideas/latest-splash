-- How a business's limits start, and two people for a large grant (v2 Phase 3, Sky's decision).
--
-- 1. A new business starts at 50,000 USDC a payment, 100,000 a day and a monthly figure worked out from the three
--    questions it answers (lib/limits/start.ts). Those are starting points, not ceilings (lib/limits/rules.ts
--    DEFAULT_LIMITS, LIMIT_SANITY_MAX). Nothing existing is lowered or changed: step 4 gives EVERY business that
--    exists today a row for each limit at the figure it already runs on, so the new starting figures apply to businesses
--    made after this and to none made before it. (A business with no row for a limit has the starting figure; before
--    this a business with no row had the old standard of 2,000 / 5,000 / 20,000 USDC and 90 days.)
--
-- 2. business_limit_answers: the three answers a business gave, as it wrote them (cleaned, at most 40 characters each, never
--    longer), what was read from them, and the proposal worked out with what it asked for beyond the starting figures. One
--    row per business. `applied_at` is set once, when the business was started at the proposal; a business that already
--    had limits is never started from its answers, it is shown the proposal and can ask for it. The answers are never
--    written to the trail or the logs.
--
-- 3. business_limits.source gains 'starting' (a new business, started at its proposal; changed_by 'system:onboarding').
--
-- 4. business_limit_requests gains a first approval and the role of the second. A grant that takes the daily limit above
--    250,000 USDC or the monthly limit above 2,500,000 USDC needs two different Splash staff, one compliance and one
--    operations (lib/limits/rules.ts LARGE_GRANT_LINES; these two numbers repeat them and move together). The first
--    approval is recorded on the request and starts nothing: the request stays 'pending' and the 24 hour notice runs from
--    the second approval, `decided_at`. The checks hold the rule even for a statement that skips the service.
--
-- 5. The trail gains 'limit_answers_saved' and 'limit_request_first_approved'.
CREATE TABLE IF NOT EXISTS "business_limit_answers" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "monthly_text" text NOT NULL,
  "per_week_text" text NOT NULL,
  "first_text" text NOT NULL,
  "monthly_minor" bigint NOT NULL,
  "per_week" integer NOT NULL,
  "first_minor" bigint NOT NULL,
  "proposed_per_payment" bigint NOT NULL,
  "proposed_daily" bigint NOT NULL,
  "proposed_monthly" bigint NOT NULL,
  "wanted_per_payment" bigint NOT NULL,
  "wanted_daily" bigint NOT NULL,
  "wanted_monthly" bigint NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "formula_version" integer NOT NULL,
  "answered_by" text NOT NULL,
  "applied_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "business_limit_answers_text" CHECK (char_length("monthly_text") BETWEEN 1 AND 40 AND char_length("per_week_text") BETWEEN 1 AND 40 AND char_length("first_text") BETWEEN 1 AND 40),
  CONSTRAINT "business_limit_answers_values" CHECK ("monthly_minor" > 0 AND "per_week" > 0 AND "first_minor" > 0),
  CONSTRAINT "business_limit_answers_proposal" CHECK ("proposed_per_payment" > 0 AND "proposed_daily" > 0 AND "proposed_monthly" > 0 AND "proposed_per_payment" <= "wanted_per_payment" AND "proposed_daily" <= "wanted_daily" AND "proposed_monthly" <= "wanted_monthly"),
  CONSTRAINT "business_limit_answers_version" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_limit_answers_org_unique" ON "business_limit_answers" ("org_id");
--> statement-breakpoint
ALTER TABLE "business_limits" DROP CONSTRAINT IF EXISTS "business_limits_source";
--> statement-breakpoint
ALTER TABLE "business_limits" ADD CONSTRAINT "business_limits_source" CHECK ("source" IN ('raised', 'lowered', 'restored', 'starting'));
--> statement-breakpoint
ALTER TABLE "business_limit_requests" ADD COLUMN IF NOT EXISTS "first_approved_by" text;
--> statement-breakpoint
ALTER TABLE "business_limit_requests" ADD COLUMN IF NOT EXISTS "first_approver_role" text;
--> statement-breakpoint
ALTER TABLE "business_limit_requests" ADD COLUMN IF NOT EXISTS "first_approved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "business_limit_requests" ADD COLUMN IF NOT EXISTS "first_granted_value" bigint;
--> statement-breakpoint
ALTER TABLE "business_limit_requests" ADD COLUMN IF NOT EXISTS "decided_role" text;
--> statement-breakpoint
ALTER TABLE "business_limit_requests" DROP CONSTRAINT IF EXISTS "business_limit_requests_first";
--> statement-breakpoint
ALTER TABLE "business_limit_requests" ADD CONSTRAINT "business_limit_requests_first" CHECK (
  ("first_approved_by" IS NULL AND "first_approver_role" IS NULL AND "first_approved_at" IS NULL AND "first_granted_value" IS NULL)
  OR ("first_approved_by" IS NOT NULL AND "first_approver_role" IN ('compliance', 'operations') AND "first_approved_at" IS NOT NULL AND "first_granted_value" IS NOT NULL AND "first_granted_value" > "current_value" AND "first_granted_value" <= "requested_value")
);
--> statement-breakpoint
ALTER TABLE "business_limit_requests" DROP CONSTRAINT IF EXISTS "business_limit_requests_two_people";
--> statement-breakpoint
ALTER TABLE "business_limit_requests" ADD CONSTRAINT "business_limit_requests_two_people" CHECK (
  "status" NOT IN ('approved', 'applied') OR "first_approved_by" IS NULL OR lower("first_approved_by") <> lower("decided_by")
);
--> statement-breakpoint
ALTER TABLE "business_limit_requests" DROP CONSTRAINT IF EXISTS "business_limit_requests_two_roles";
--> statement-breakpoint
ALTER TABLE "business_limit_requests" ADD CONSTRAINT "business_limit_requests_two_roles" CHECK (
  "status" NOT IN ('approved', 'applied') OR "first_approved_by" IS NULL OR ("decided_role" IN ('compliance', 'operations') AND "decided_role" <> "first_approver_role")
);
--> statement-breakpoint
-- The two lines repeat lib/limits/rules.ts LARGE_GRANT_LINES (USDC minor units): daily 250,000 USDC, monthly 2,500,000 USDC.
ALTER TABLE "business_limit_requests" DROP CONSTRAINT IF EXISTS "business_limit_requests_large";
--> statement-breakpoint
ALTER TABLE "business_limit_requests" ADD CONSTRAINT "business_limit_requests_large" CHECK (
  "status" NOT IN ('approved', 'applied')
  OR "first_approved_by" IS NOT NULL
  OR NOT (("kind" = 'daily' AND "granted_value" > 250000000000) OR ("kind" = 'monthly' AND "granted_value" > 2500000000000))
);
--> statement-breakpoint
ALTER TABLE "wallet_authority_events" DROP CONSTRAINT IF EXISTS "wallet_authority_events_action_check";
--> statement-breakpoint
ALTER TABLE "wallet_authority_events" ADD CONSTRAINT "wallet_authority_events_action_check" CHECK ("action" IN (
  'person_in_charge_appointed', 'person_in_charge_revoked',
  'migration_sign_off_prepared', 'migration_signed_off', 'migration_sign_off_used', 'migration_sign_off_voided',
  'approval_requested', 'approval_accepted', 'approval_declined', 'approval_withdrawn', 'approval_completed',
  'member_offboarded', 'spending_rules_revoke_opened',
  'member_added', 'member_role_changed', 'member_removed',
  'finance_lead_appointed', 'finance_lead_revoked',
  'member_access_granted', 'member_access_revoked',
  'schedule_created', 'schedule_changed', 'schedule_run_skipped', 'schedule_stopped', 'schedule_resumed', 'schedule_deleted',
  'automatic_payments_paused', 'automatic_payments_resumed', 'automatic_allowance_requested', 'automatic_allowance_revoke_requested',
  'automatic_grace_changed',
  'team_invitation_sent', 'team_invitation_accepted', 'team_invitation_declined', 'team_invitation_withdrawn', 'team_invitation_expired',
  'leave_requested', 'leave_withdrawn', 'leave_approved', 'leave_declined', 'leave_follow_up',
  'limit_raise_requested', 'limit_lowered', 'limit_request_approved', 'limit_request_declined', 'limit_request_cancelled', 'limit_change_applied',
  'limit_restored',
  'member_title_changed',
  'exchange_name_sharing_changed',
  'limit_answers_saved',
  'limit_request_first_approved'
));
--> statement-breakpoint
-- Every business that exists keeps the figures it already runs on. A business with a row for a limit (migration 0079 kept
-- what some ran on; an owner may have lowered one) keeps that row. Every other limit gets a row at the figure that was
-- the standard until now: 2,000 USDC a payment, 5,000 a day, 20,000 a month, 90 days. A line on the trail says so, with
-- the same figure before and after: nothing is lowered, raised or changed.
WITH "legacy" ("kind", "value") AS (
  VALUES ('per_payment', 2000000000::bigint), ('daily', 5000000000::bigint), ('monthly', 20000000000::bigint), ('days', 90::bigint)
), "written" AS (
  INSERT INTO "business_limits" ("org_id", "kind", "value", "source", "changed_by", "request_id", "updated_at", "held_max")
  SELECT o."id", l."kind", l."value", 'raised', 'system:migration', NULL, now(), l."value"
  FROM "organizations" o CROSS JOIN "legacy" l
  ON CONFLICT ("org_id", "kind") DO NOTHING
  RETURNING "org_id", "kind", "value"
)
INSERT INTO "wallet_authority_events" ("id", "org_id", "actor_user_id", "action", "ref", "detail")
SELECT 'wae_' || gen_random_uuid()::text, w."org_id", 'system:migration', 'limit_change_applied', NULL,
  jsonb_build_object('kind', w."kind", 'before', w."value"::text, 'after', w."value"::text, 'because', 'the business keeps the figure it already ran on; the new starting figures are for businesses made after this')
FROM "written" w;
