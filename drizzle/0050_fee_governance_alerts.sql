-- Fee governance alerts (v2 Phase 2, A1 §2.9 and §6): every business owner
-- is told when the canonical FeeConfig holds a pending fee schedule or a
-- pending fee recipient (FeeScheduleProposed, FeeRecipientProposed), and
-- when one has taken effect. The monitor reads the FeeConfig's state, as it
-- reads the upgrade wrapper and the compliance config
-- (lib/server/governance-events.ts), and stores its last read in
-- governance_watch_state as a third subject.

ALTER TABLE "governance_alerts" DROP CONSTRAINT IF EXISTS "governance_alerts_kind_check";
--> statement-breakpoint
ALTER TABLE "governance_alerts" ADD CONSTRAINT "governance_alerts_kind_check" CHECK ("kind" IN ('upgrade_proposed', 'owner_change_proposed', 'registry_addition_proposed', 'upgrade_committed', 'registry_addition_activated', 'fee_schedule_proposed', 'fee_recipient_proposed', 'fee_schedule_applied', 'fee_recipient_applied'));
--> statement-breakpoint
ALTER TABLE "governance_alerts" ADD COLUMN IF NOT EXISTS "fee_kind" integer;
--> statement-breakpoint
ALTER TABLE "governance_alerts" ADD COLUMN IF NOT EXISTS "fee_recipient" text;
--> statement-breakpoint
-- A fee schedule alert names its payment kind (fee_config: 0 Splash business,
-- 1 wallet, 2 exchange, 3 another chain, 4 bank payout); no other alert does.
ALTER TABLE "governance_alerts" ADD CONSTRAINT "governance_alerts_fee_kind_check" CHECK (
  ("kind" IN ('fee_schedule_proposed', 'fee_schedule_applied') AND "fee_kind" BETWEEN 0 AND 4)
  OR ("kind" NOT IN ('fee_schedule_proposed', 'fee_schedule_applied') AND "fee_kind" IS NULL)
);
--> statement-breakpoint
-- A fee recipient alert names the recipient, a full Sui address.
ALTER TABLE "governance_alerts" ADD CONSTRAINT "governance_alerts_fee_recipient_check" CHECK (
  ("kind" IN ('fee_recipient_proposed', 'fee_recipient_applied') AND "fee_recipient" ~ '^0x[0-9a-f]{64}$')
  OR ("kind" NOT IN ('fee_recipient_proposed', 'fee_recipient_applied') AND "fee_recipient" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "governance_watch_state" DROP CONSTRAINT IF EXISTS "governance_watch_state_subject_kind_check";
--> statement-breakpoint
ALTER TABLE "governance_watch_state" ADD CONSTRAINT "governance_watch_state_subject_kind_check" CHECK ("subject_kind" IN ('wrapper', 'config', 'fee_config'));
