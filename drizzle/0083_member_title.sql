-- A member's job title (v2 Phase 3, p3-member-title).
--
-- Sky asked that people always show with their title, "Aisha (CFO)". Round four built the
-- label but a membership had no title to put in it, so every label read the role word
-- ("Aisha (Owner)"). This adds the field.
--
--   memberships.title   free text, plain words, at most 40 characters, NULL by default.
--                       NULL means "no title": the app then says the role word ("Owner",
--                       "Staff", "Approver", "Viewer") or "Finance lead" for the appointed
--                       approver, exactly as it did before this migration.
--
-- Nobody is given a title here: no existing row is touched, and the column starts empty for
-- everyone. An owner sets anyone's title in their own business, and a person sets their own
-- (Settings, Team); the app cleans it to plain words (no links, markup, control or hidden
-- characters, collapsed spaces, brackets and commas turned into spaces, cut to 40 characters
-- with the ellipsis counted) before it is written. The CHECK below is the backstop for a
-- path that forgets: the database refuses more than 40 characters.
--
-- The title is a snapshot where it matters: a decline writes the name and title as they were
-- (migration 0081), so changing a title later never rewrites an old "Declined by Aisha (CFO)".
--
-- The trail gains 'member_title_changed' (an owner's change, or a person's own). The CHECK on
-- wallet_authority_events.action is re-listed IN FULL, every value of migration 0079 plus the
-- new one, because a CHECK cannot be extended: dropping it and adding a shorter list would
-- refuse the lines already written. tests/member-title.test.mjs compares this list with 0079's.
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "title" text;
--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT IF EXISTS "memberships_title_length";
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_title_length" CHECK ("title" IS NULL OR char_length("title") <= 40);
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
  'member_title_changed'
));
