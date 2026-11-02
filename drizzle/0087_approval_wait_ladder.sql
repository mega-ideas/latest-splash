-- When nobody who can approve answers (v2 Phase 3, p3-no-approver; Sky's question).
--
-- A payment the rules send to the owners, a staff payment above the second-approval line and an
-- automatic run handed back to "ask me first" all become a request that waits for people who can
-- approve. Money is never approved by default, by Splash, or by a timer. So a waiting request is
-- told to its approvers at once, again at 10 minutes, 1 hour and 4 hours, and if nobody answers
-- before its existing end it lapses UNPAID, and the requester and the owners are told in plain words.
--
-- 1. approval_wait_steps: one row per (kind of request, request id, step). The row IS the idempotency
--    key: "asked", "reminder_10m", "reminder_1h", "reminder_4h", "lapsed" and each "Remind them now"
--    ("manual_N") happen once, however often the cron runs. Written in the same transaction as the
--    notices of that step, so a step is never half recorded.
-- 2. approval_notices: one row per person told at a step. It is the in-app notice and the record of
--    the e-mail (claimed before it is sent, like the invitation e-mail). Words only: no amount, no
--    payee, no address and no secret; the link is the signed-in Approve page and signs nothing.
-- 3. wallet_authority_events: two more lines on the trail, "approval_lapsed" and "approval_reminded".
--    The CHECK is re-listed IN FULL (it replaces the one in 0086).
CREATE TABLE IF NOT EXISTS "approval_wait_steps" (
  "subject_kind" text NOT NULL,
  "subject_id" text NOT NULL,
  "step" text NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("subject_kind", "subject_id", "step"),
  CONSTRAINT "approval_wait_steps_kind" CHECK ("subject_kind" IN ('signing', 'ask')),
  CONSTRAINT "approval_wait_steps_step" CHECK ("step" ~ '^(asked|reminder_10m|reminder_1h|reminder_4h|lapsed|manual_[0-9]+)$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_wait_steps_org_idx" ON "approval_wait_steps" ("org_id", "subject_kind", "subject_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_notices" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "subject_kind" text NOT NULL,
  "subject_id" text NOT NULL,
  "step" text NOT NULL,
  "user_id" text NOT NULL,
  "audience" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "link_path" text NOT NULL,
  "email_state" text NOT NULL DEFAULT 'pending',
  "email_attempts" integer NOT NULL DEFAULT 0,
  "email_claimed_at" timestamp with time zone,
  "email_sent_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "approval_notices_step_fk" FOREIGN KEY ("subject_kind", "subject_id", "step") REFERENCES "approval_wait_steps"("subject_kind", "subject_id", "step"),
  CONSTRAINT "approval_notices_audience" CHECK ("audience" IN ('approver', 'requester', 'owner')),
  CONSTRAINT "approval_notices_email_state" CHECK ("email_state" IN ('pending', 'sending', 'sent', 'failed', 'not_configured'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_notices_once" ON "approval_notices" ("subject_kind", "subject_id", "step", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_notices_user_idx" ON "approval_notices" ("org_id", "user_id", "created_at");
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
  'limit_request_first_approved',
  'approval_lapsed', 'approval_reminded'
));
