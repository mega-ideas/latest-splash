-- Whose name the exchange is told (v2 Phase 3, p3-disclosure; Sky's decision).
--
-- When a staff member pays an exchange account alone, the Travel Rule message says who sent the payment.
-- By default "Sent by NAME (Title): purpose". Two switches, both ON by default, decide it:
--
--   organizations.share_names_with_exchange   the business's choice. Only an owner changes it.
--   memberships.share_name_with_exchange      the person's own choice. Only that person changes it.
--
-- If either is off, the details read "Sent by COMPANY NAME: purpose" and no person's name or title is sent.
-- The switches change ONLY what the exchange is told and what the confirmation shows. The audit proof
-- (the sealed evidence record and its anchor) always holds who started, approved and declined.
--
-- Nothing existing is changed: every business and every member starts with sharing ON, which is what the
-- message did before (it carried the person's name), and no stored message or payment is rewritten.
--
-- The trail gains 'exchange_name_sharing_changed' (an owner's change to the business switch). The CHECK on
-- wallet_authority_events.action is re-listed IN FULL, every value of migration 0083 plus the new one,
-- because a CHECK cannot be extended: dropping it and adding a shorter list would refuse the lines already
-- written. tests/exchange-names.test.mjs compares this list with 0083's.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "share_names_with_exchange" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "share_name_with_exchange" boolean NOT NULL DEFAULT true;
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
  'exchange_name_sharing_changed'
));
