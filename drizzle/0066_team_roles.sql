-- The team is the business's to run (v2 Phase 3, Sky's decision).
--
-- 1. `wallet_authority_events` records seven more actions: a person added, a
--    role changed, a person removed, the Finance lead appointed and taken
--    back, and Add funds or Withdraw access granted and taken back. The trail
--    stays append-only (migration 0035's trigger).
-- 2. `wallet_finance_leads`: the Finance lead. One person per business at a
--    time (a partial unique index on the business while the appointment is
--    open), appointed and taken back by an owner. It sits on top of a
--    membership, as the person in charge does; it adds no role to the
--    memberships table. A row grants nothing unless the person is still an
--    approver of that business (lib/server/team-admin.ts reads both).
-- 3. `wallet_member_access`: who may use Add funds and Withdraw inside the
--    dashboard, member by member. Owners have both and need no row. A row is
--    open until an owner takes it back; one open row per business, person
--    and kind. Money still moves only by the owners' quorum on chain.

ALTER TABLE "wallet_authority_events" DROP CONSTRAINT IF EXISTS "wallet_authority_events_action_check";
--> statement-breakpoint
ALTER TABLE "wallet_authority_events" ADD CONSTRAINT "wallet_authority_events_action_check" CHECK ("action" IN (
  'person_in_charge_appointed', 'person_in_charge_revoked',
  'migration_sign_off_prepared', 'migration_signed_off', 'migration_sign_off_used', 'migration_sign_off_voided',
  'approval_requested', 'approval_accepted', 'approval_declined', 'approval_withdrawn', 'approval_completed',
  'member_offboarded', 'spending_rules_revoke_opened',
  'member_added', 'member_role_changed', 'member_removed',
  'finance_lead_appointed', 'finance_lead_revoked',
  'member_access_granted', 'member_access_revoked'
));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_finance_leads" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- A user id, or `operator:<email>`; plain ids, as the rest of the trail keeps them (0037).
  "granted_by" text NOT NULL,
  "granted_at" timestamp with time zone NOT NULL,
  "revoked_by" text,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "wallet_finance_leads_revocation" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_finance_leads_one_open" ON "wallet_finance_leads" ("org_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_member_access" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "access" text NOT NULL,
  "granted_by" text NOT NULL,
  "granted_at" timestamp with time zone NOT NULL,
  "revoked_by" text,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "wallet_member_access_kind" CHECK ("access" IN ('add_funds', 'withdraw')),
  CONSTRAINT "wallet_member_access_revocation" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_member_access_one_open" ON "wallet_member_access" ("org_id", "user_id", "access") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_member_access_org_idx" ON "wallet_member_access" ("org_id", "user_id");
