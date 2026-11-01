-- A business keeps the limits it already runs on, and an owner can put back a
-- limit they lowered (v2 Phase 3, the reviewer's findings on migration 0078).
--
-- 1. held_max: the highest figure a business has legitimately held for a limit
--    (the standard, a figure it already ran on before limits arrived, or a
--    higher limit Splash approved and whose notice passed). An owner who lowers
--    a limit may put it back to this figure at once, with nothing asked of
--    Splash; a figure above it is still a request. Never below `value`.
--
-- 2. Keeping what runs. Limits arrive with the standard figures (2,000 USDC a
--    payment, 5,000 a day, 20,000 a month, 90 days). A business that already
--    has a signed allowance or a daily limit above those must not have its
--    automatic payments handed back the day this deploys. So every business
--    gets a row, source 'raised', changed_by 'system:migration', for each limit
--    where what it runs on is above the standard, at that figure and never
--    above the ceiling (10,000 per payment, 50,000 a day, 500,000 a month,
--    366 days; lib/limits/rules.ts LIMIT_CEILINGS). What it runs on is:
--      * a day: the daily limit the owners set (scheduled_payment_settings);
--      * a payment, a month, days: the latest allowance an owner asked for
--        whose request was signed, or is still being signed (the trail line
--        'automatic_allowance_requested' and its wallet_signing_requests row).
--    A business at or below the standard on a limit gets no row for it. Each
--    row written has a line on the trail, 'limit_change_applied', by
--    'system:migration'. Nothing here moves money or touches a chain.
--
-- 3. The trail gains 'limit_restored', and business_limits.source gains
--    'restored' (an owner put the limit back).
--
-- The standard and ceiling figures below are the code's at the time of writing;
-- tests/limits-keep-restore.test.mjs runs this migration over a business that
-- has them and checks the result against lib/limits/rules.ts.
ALTER TABLE "business_limits" ADD COLUMN IF NOT EXISTS "held_max" bigint;
--> statement-breakpoint
UPDATE "business_limits" SET "held_max" = GREATEST("value", CASE "kind" WHEN 'per_payment' THEN 2000000000 WHEN 'daily' THEN 5000000000 WHEN 'monthly' THEN 20000000000 ELSE 90 END) WHERE "held_max" IS NULL;
--> statement-breakpoint
ALTER TABLE "business_limits" ALTER COLUMN "held_max" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "business_limits" DROP CONSTRAINT IF EXISTS "business_limits_held";
--> statement-breakpoint
ALTER TABLE "business_limits" ADD CONSTRAINT "business_limits_held" CHECK ("held_max" >= "value");
--> statement-breakpoint
ALTER TABLE "business_limits" DROP CONSTRAINT IF EXISTS "business_limits_source";
--> statement-breakpoint
ALTER TABLE "business_limits" ADD CONSTRAINT "business_limits_source" CHECK ("source" IN ('raised', 'lowered', 'restored'));
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
  'limit_restored'
));
--> statement-breakpoint
WITH "allowance" AS (
  SELECT DISTINCT ON (e."org_id")
    e."org_id",
    CASE WHEN e."detail"->>'perPaymentMinor' ~ '^[0-9]{1,18}$' THEN (e."detail"->>'perPaymentMinor')::bigint END AS "per_payment",
    CASE WHEN e."detail"->>'monthlyMinor' ~ '^[0-9]{1,18}$' THEN (e."detail"->>'monthlyMinor')::bigint END AS "monthly",
    CASE WHEN e."detail"->>'days' ~ '^[0-9]{1,4}$' THEN (e."detail"->>'days')::bigint END AS "days"
  FROM "wallet_authority_events" e
  JOIN "wallet_signing_requests" r ON r."id" = e."ref" AND r."org_id" = e."org_id" AND r."status" IN ('executed', 'collecting', 'submitting', 'unknown')
  WHERE e."action" = 'automatic_allowance_requested'
  ORDER BY e."org_id", e."seq" DESC
), "wanted" AS (
  SELECT "org_id", 'per_payment'::text AS "kind", "per_payment" AS "value", 2000000000::bigint AS "standard", 10000000000::bigint AS "ceiling" FROM "allowance"
  UNION ALL SELECT "org_id", 'monthly'::text, "monthly", 20000000000::bigint, 500000000000::bigint FROM "allowance"
  UNION ALL SELECT "org_id", 'days'::text, "days", 90::bigint, 366::bigint FROM "allowance"
  UNION ALL SELECT "org_id", 'daily'::text, "daily_cap_minor", 5000000000::bigint, 50000000000::bigint FROM "scheduled_payment_settings"
), "kept" AS (
  SELECT "org_id", "kind", LEAST("value", "ceiling") AS "value", "standard"
  FROM "wanted"
  WHERE "value" IS NOT NULL AND "value" > "standard"
), "written" AS (
  INSERT INTO "business_limits" ("org_id", "kind", "value", "source", "changed_by", "request_id", "updated_at", "held_max")
  SELECT "org_id", "kind", "value", 'raised', 'system:migration', NULL, now(), "value" FROM "kept"
  ON CONFLICT ("org_id", "kind") DO NOTHING
  RETURNING "org_id", "kind", "value"
)
INSERT INTO "wallet_authority_events" ("id", "org_id", "actor_user_id", "action", "ref", "detail")
SELECT 'wae_' || gen_random_uuid()::text, w."org_id", 'system:migration', 'limit_change_applied', NULL,
  jsonb_build_object('kind', w."kind", 'before', k."standard"::text, 'after', w."value"::text, 'because', 'the business already ran on this figure before limits arrived')
FROM "written" w JOIN "kept" k ON k."org_id" = w."org_id" AND k."kind" = w."kind";
