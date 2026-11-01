-- A business's limits on automatic payments, and asking Splash for higher ones
-- (v2 Phase 3, Sky's decision).
--
-- business_limits: a limit that is not the standard one. A business with no row
-- for a kind has the standard limit (lib/limits/rules.ts DEFAULT_LIMITS: 2,000,
-- 5,000 and 20,000 USDC, and 90 days). A row is written when an owner LOWERS a
-- limit (at once, nothing asked) or when an approved higher limit takes effect.
-- `value` is USDC minor units for the three amounts and a number of days for
-- `days`. The ceiling is in code, not here: the service refuses a figure above
-- it, and the CHECK below keeps a row above zero.
--
-- business_limit_requests: an owner asks Splash for a higher limit. Splash staff
-- approve it (or approve a smaller figure) or decline it with a reason; an
-- approval starts the 24 hour notice (`effective_at` is at least `decided_at`
-- plus 24 hours, by CHECK) and the owner can cancel until then. When the notice
-- has passed the request is `applied` and the limit row is written, in one
-- transaction.
--   * request_key is the caller's idempotency key: the same key is the same
--     request, so a retry or a double-click asks once.
--   * one open request (pending or approved) per business and limit.
--   * the *_notified_at columns are claimed before an e-mail or a message is
--     sent and released when it reached no one, so an owner is told once and a
--     notice that reached nobody is tried again.
-- Nothing in these tables moves money.
--
-- wallet_authority_events: the trail gains the actions below. A staff member's
-- action is written as `operator:<email>`, an owner's as their user id, the
-- notice running out as `system:limits`. Still append-only (migration 0035).
CREATE TABLE IF NOT EXISTS "business_limits" (
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "kind" text NOT NULL,
  "value" bigint NOT NULL,
  "source" text NOT NULL,
  "changed_by" text NOT NULL,
  "request_id" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "business_limits_pk" PRIMARY KEY ("org_id", "kind"),
  CONSTRAINT "business_limits_kind" CHECK ("kind" IN ('per_payment', 'daily', 'monthly', 'days')),
  CONSTRAINT "business_limits_source" CHECK ("source" IN ('raised', 'lowered')),
  CONSTRAINT "business_limits_value" CHECK ("value" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_limit_requests" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "kind" text NOT NULL,
  "requested_value" bigint NOT NULL,
  "current_value" bigint NOT NULL,
  "reason" text NOT NULL,
  "request_key" text NOT NULL,
  "requested_by" text NOT NULL,
  "requested_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "granted_value" bigint,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "decline_reason" text,
  "effective_at" timestamp with time zone,
  "applied_at" timestamp with time zone,
  "cancelled_by" text,
  "cancelled_at" timestamp with time zone,
  "approved_notified_at" timestamp with time zone,
  "declined_notified_at" timestamp with time zone,
  "effective_notified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "business_limit_requests_kind" CHECK ("kind" IN ('per_payment', 'daily', 'monthly', 'days')),
  CONSTRAINT "business_limit_requests_status" CHECK ("status" IN ('pending', 'approved', 'declined', 'cancelled', 'applied')),
  CONSTRAINT "business_limit_requests_values" CHECK ("requested_value" > 0 AND "current_value" > 0 AND ("granted_value" IS NULL OR ("granted_value" > "current_value" AND "granted_value" <= "requested_value"))),
  CONSTRAINT "business_limit_requests_approved" CHECK (("status" NOT IN ('approved', 'applied')) OR ("granted_value" IS NOT NULL AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "effective_at" IS NOT NULL AND "effective_at" >= "decided_at" + interval '24 hours')),
  CONSTRAINT "business_limit_requests_declined" CHECK (("status" <> 'declined') OR ("decline_reason" IS NOT NULL AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)),
  CONSTRAINT "business_limit_requests_cancelled" CHECK (("status" <> 'cancelled') OR ("cancelled_by" IS NOT NULL AND "cancelled_at" IS NOT NULL)),
  CONSTRAINT "business_limit_requests_applied" CHECK (("status" <> 'applied') OR "applied_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_limit_requests_key_unique" ON "business_limit_requests" ("org_id", "request_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_limit_requests_one_open" ON "business_limit_requests" ("org_id", "kind") WHERE "status" IN ('pending', 'approved');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_limit_requests_queue_idx" ON "business_limit_requests" ("status", "requested_at");
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
  'limit_raise_requested', 'limit_lowered', 'limit_request_approved', 'limit_request_declined', 'limit_request_cancelled', 'limit_change_applied'
));
