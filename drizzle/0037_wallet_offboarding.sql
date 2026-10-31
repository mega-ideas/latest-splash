-- Offboarding and the life of the audit trail (v2 §4.1 / §4.2 review).
--
-- 1. The wallet's authority records outlive the people in them. Who acted,
--    who was appointed, who signed a sign-off, who asked and who decided are
--    kept as plain ids, with no foreign key to `users`: deleting a user (the
--    dev reset, an account-erasure request) must not be blocked by an
--    append-only trail, and a cascade would be refused by its trigger
--    anyway. An actor may also be a Splash operator (`operator:<email>`),
--    who has no user row. The rows that ARE current authority (the
--    appointment itself, a sign-off for a member) still go with the user
--    (ON DELETE CASCADE, as before).
-- 2. Two new trail actions: `member_offboarded` (a membership removed, with
--    the addresses that may still hold a spending rule) and
--    `spending_rules_revoke_opened` (the owners were asked to take those
--    rules back).
-- 3. `wallet_offboarded_spenders`: each address of a member who was removed.
--    A spending rule lives on chain, beyond Splash's reach: until the
--    owners' quorum revokes it the index shows it as orphaned. A row is
--    resolved when an executed spending-rule change removes that spender
--    from the policy.

ALTER TABLE "wallet_authority_events" DROP CONSTRAINT IF EXISTS "wallet_authority_events_actor_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "wallet_authority_events" DROP CONSTRAINT IF EXISTS "wallet_authority_events_subject_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "wallet_authority_events" DROP CONSTRAINT IF EXISTS "wallet_authority_events_action_check";
--> statement-breakpoint
ALTER TABLE "wallet_authority_events" ADD CONSTRAINT "wallet_authority_events_action_check" CHECK ("action" IN (
  'person_in_charge_appointed', 'person_in_charge_revoked',
  'migration_sign_off_prepared', 'migration_signed_off', 'migration_sign_off_used', 'migration_sign_off_voided',
  'approval_requested', 'approval_accepted', 'approval_declined', 'approval_withdrawn', 'approval_completed',
  'member_offboarded', 'spending_rules_revoke_opened'
));
--> statement-breakpoint
ALTER TABLE "wallet_persons_in_charge" DROP CONSTRAINT IF EXISTS "wallet_persons_in_charge_granted_by_fkey";
--> statement-breakpoint
ALTER TABLE "wallet_persons_in_charge" DROP CONSTRAINT IF EXISTS "wallet_persons_in_charge_revoked_by_fkey";
--> statement-breakpoint
ALTER TABLE "wallet_migration_signoffs" DROP CONSTRAINT IF EXISTS "wallet_migration_signoffs_signed_by_fkey";
--> statement-breakpoint
ALTER TABLE "wallet_approval_asks" DROP CONSTRAINT IF EXISTS "wallet_approval_asks_requested_by_fkey";
--> statement-breakpoint
ALTER TABLE "wallet_approval_asks" DROP CONSTRAINT IF EXISTS "wallet_approval_asks_decided_by_fkey";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_offboarded_spenders" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL,
  "address" text NOT NULL,
  "reason" text NOT NULL,
  "offboarded_by" text NOT NULL,
  "offboarded_at" timestamp with time zone NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "wallet_offboarded_spenders_reason_check" CHECK ("reason" IN ('removed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_offboarded_spenders_org_idx" ON "wallet_offboarded_spenders" ("org_id", "address") WHERE "resolved_at" IS NULL;
