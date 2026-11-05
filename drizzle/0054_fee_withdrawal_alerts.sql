-- Fee governance alerts, review fixes (v2 Phase 2, A1 §2.9 and §6): a
-- withdrawn fee proposal (FeeScheduleProposalCancelled,
-- FeeRecipientProposalCancelled) is an owner alert of its own, derived from
-- the FeeConfig's state like the rest (lib/server/governance-events.ts).
-- `fee_schedule_withdrawn` names the payment kind; `fee_recipient_withdrawn`
-- names the recipient the withdrawn proposal named.

ALTER TABLE "governance_alerts" DROP CONSTRAINT IF EXISTS "governance_alerts_kind_check";
--> statement-breakpoint
ALTER TABLE "governance_alerts" ADD CONSTRAINT "governance_alerts_kind_check" CHECK ("kind" IN ('upgrade_proposed', 'owner_change_proposed', 'registry_addition_proposed', 'upgrade_committed', 'registry_addition_activated', 'fee_schedule_proposed', 'fee_recipient_proposed', 'fee_schedule_applied', 'fee_recipient_applied', 'fee_schedule_withdrawn', 'fee_recipient_withdrawn'));
--> statement-breakpoint
ALTER TABLE "governance_alerts" DROP CONSTRAINT IF EXISTS "governance_alerts_fee_kind_check";
--> statement-breakpoint
ALTER TABLE "governance_alerts" ADD CONSTRAINT "governance_alerts_fee_kind_check" CHECK (
  ("kind" IN ('fee_schedule_proposed', 'fee_schedule_applied', 'fee_schedule_withdrawn') AND "fee_kind" BETWEEN 0 AND 4)
  OR ("kind" NOT IN ('fee_schedule_proposed', 'fee_schedule_applied', 'fee_schedule_withdrawn') AND "fee_kind" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "governance_alerts" DROP CONSTRAINT IF EXISTS "governance_alerts_fee_recipient_check";
--> statement-breakpoint
ALTER TABLE "governance_alerts" ADD CONSTRAINT "governance_alerts_fee_recipient_check" CHECK (
  ("kind" IN ('fee_recipient_proposed', 'fee_recipient_applied', 'fee_recipient_withdrawn') AND "fee_recipient" ~ '^0x[0-9a-f]{64}$')
  OR ("kind" NOT IN ('fee_recipient_proposed', 'fee_recipient_applied', 'fee_recipient_withdrawn') AND "fee_recipient" IS NULL)
);
