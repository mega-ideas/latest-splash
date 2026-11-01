-- Inviting people to the team, and leaving it (v2 Phase 3, Sky's decision of 1 Nov).
--
-- 1. `team_invitations`: an owner (or the Finance lead, below owner) invites an
--    email. The person sees it after signing in with that verified email and
--    accepts or declines; it ends 7 days after it was sent; its sender can
--    withdraw it. There is deliberately NO token, code or link column: the
--    invitation is found by the signed-in person's own verified email, so there
--    is nothing to leak in a URL or to replay. The id is random, but knowing it
--    grants nothing. One open invitation per business and email (a partial
--    unique index). Rows are history after they close.
-- 2. `team_leave_requests`: a member asks to leave. Nothing changes until an
--    owner (or, for people below owner who hold nothing granted, the Finance
--    lead) approves. One open request per business and person. `closed` means
--    the person was removed another way while it was open.
-- 3. `wallet_authority_events` records nine more actions so every step is on
--    the append-only trail (migration 0035's trigger stays).

CREATE TABLE IF NOT EXISTS "team_invitations" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  -- Lowercased, as users.email is.
  "email" text NOT NULL,
  "role" text NOT NULL,
  -- A user id; a plain id as the rest of the trail keeps them (0037).
  "invited_by" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "decided_at" timestamp with time zone,
  -- The person who answered, the sender who withdrew, or `system:<reason>`.
  "decided_by" text,
  CONSTRAINT "team_invitations_role_check" CHECK ("role" IN ('viewer', 'maker', 'checker', 'admin')),
  CONSTRAINT "team_invitations_status_check" CHECK ("status" IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired')),
  CONSTRAINT "team_invitations_decision" CHECK (("status" = 'pending') = ("decided_at" IS NULL)),
  CONSTRAINT "team_invitations_lifetime" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_invitations_one_open" ON "team_invitations" ("org_id", "email") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_invitations_email_idx" ON "team_invitations" ("email", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_invitations_org_idx" ON "team_invitations" ("org_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_leave_requests" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL,
  "decided_at" timestamp with time zone,
  "decided_by" text,
  CONSTRAINT "team_leave_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'declined', 'withdrawn', 'closed')),
  CONSTRAINT "team_leave_requests_decision" CHECK (("status" = 'pending') = ("decided_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_leave_requests_one_open" ON "team_leave_requests" ("org_id", "user_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_leave_requests_org_idx" ON "team_leave_requests" ("org_id", "status");
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
  'team_invitation_sent', 'team_invitation_accepted', 'team_invitation_declined', 'team_invitation_withdrawn', 'team_invitation_expired',
  'leave_requested', 'leave_withdrawn', 'leave_approved', 'leave_declined'
));
