-- The grace window before the first automatic payment of a run (v2 Phase 3).
--
-- "Pay automatically within my limits" tells the owners GRACE minutes before
-- the first automatic payment of a run. Until the window ends nothing is paid,
-- and Skip or Stop inside it ends the run as skipped with nothing paid.
--
-- scheduled_payment_settings.grace_minutes: per business, whole minutes 0 to 60,
-- 10 unless an owner says otherwise. Owners change it at once, with no cooldown.
-- A run's window is fixed when its notice goes out (starts_at below), so changing
-- the setting never moves a start that was announced.
--
-- payment_schedule_runs.starts_at: when the run's first automatic payment may be
-- claimed. Null while no window has been announced. Set once, when the "starting"
-- notice goes out; the payment claim itself refuses to run before it.
--
-- payment_schedule_runs.window_version: the schedule's version when the window
-- opened. If the schedule was changed inside the window the run is handed back
-- at its end, so what is paid is what the notice named.
--
-- wallet_authority_events: the trail records the owner's change of the window
-- (still append-only, migration 0035's trigger).
ALTER TABLE "scheduled_payment_settings" ADD COLUMN IF NOT EXISTS "grace_minutes" integer DEFAULT 10 NOT NULL;
--> statement-breakpoint
ALTER TABLE "scheduled_payment_settings" DROP CONSTRAINT IF EXISTS "scheduled_payment_settings_grace_check";
--> statement-breakpoint
ALTER TABLE "scheduled_payment_settings" ADD CONSTRAINT "scheduled_payment_settings_grace_check" CHECK ("grace_minutes" >= 0 AND "grace_minutes" <= 60);
--> statement-breakpoint
ALTER TABLE "payment_schedule_runs" ADD COLUMN IF NOT EXISTS "starts_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payment_schedule_runs" ADD COLUMN IF NOT EXISTS "window_version" integer;
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
  'leave_requested', 'leave_withdrawn', 'leave_approved', 'leave_declined', 'leave_follow_up'
));
