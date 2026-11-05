-- Scheduled batches (v2 Phase 3): a batch of payments to verified recipients,
-- set to fall due once, every week or every month, in one of two modes an
-- owner chooses per schedule:
--
--   ask   Splash prepares the batch at the due time and asks for approval;
--         nothing is paid until a person signs with their passkey.
--   auto  Splash pays at the due time with no one present, but only inside an
--         allowance the owners signed, to recipients already paid before.
--         Anything that fails a check is handed back to "ask", and the owners
--         are told why.
--
-- payment_schedules: one row per schedule. The recipients and amounts are kept
-- as they were when an owner saved them (`items`: the address, the amount and
-- the fee shown), so a run can tell when a recipient has changed since. Editing
-- replaces them at once; deleting marks the row deleted and keeps the history.
-- (org_id, client_key) is unique, so a double click makes one schedule.
--
-- payment_schedule_runs: one row per schedule per due date. UNIQUE
-- (schedule_id, due_date) is what makes running twice safe: a second runner
-- finds the row and does not make another. `claimed_at` is the lease a runner
-- holds while it works on the run.
--
-- payment_schedule_run_payments: for an automatic run only, one row per
-- payment, each claimed once (pending -> submitting -> paid or failed) and
-- unique per business by its payment reference, which is also the payment's
-- idempotency key on chain. `gas_budget_mist` counts toward the business's
-- 24-hour network-fee allowance.
--
-- scheduled_payment_settings: one row per business. `auto_paused` is the kill
-- switch any one owner can use; `daily_cap_minor` is the daily limit the
-- owners set, which Splash's server enforces (the allowance itself carries one
-- recurring cap, the monthly one).
--
-- wallet_authority_events: the trail records the schedule and kill-switch
-- actions too (still append-only, migration 0035's trigger).
CREATE TABLE IF NOT EXISTS "payment_schedules" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "client_key" text NOT NULL,
  "name" text NOT NULL,
  "mode" text NOT NULL,
  "cadence" text NOT NULL,
  "first_due_at" timestamp with time zone NOT NULL,
  "next_due_at" timestamp with time zone,
  "status" text NOT NULL,
  "created_by" text NOT NULL,
  "created_as" text NOT NULL,
  "items" jsonb NOT NULL,
  "item_count" integer NOT NULL,
  "total_minor" bigint NOT NULL,
  "fee_minor" bigint NOT NULL,
  "confirmed_new_payees" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "stopped_at" timestamp with time zone,
  "stopped_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_schedules_mode_check" CHECK ("mode" IN ('ask', 'auto')),
  CONSTRAINT "payment_schedules_cadence_check" CHECK ("cadence" IN ('once', 'weekly', 'monthly')),
  CONSTRAINT "payment_schedules_status_check" CHECK ("status" IN ('active', 'stopped', 'completed', 'deleted')),
  CONSTRAINT "payment_schedules_created_as_check" CHECK ("created_as" IN ('owner', 'finance_lead')),
  CONSTRAINT "payment_schedules_items_check" CHECK ("item_count" >= 1 AND "item_count" <= 20 AND "total_minor" > 0 AND "fee_minor" >= 0),
  -- An automatic schedule is an owner's: it relies on an allowance the owners signed.
  CONSTRAINT "payment_schedules_auto_owner_check" CHECK ("mode" = 'ask' OR "created_as" = 'owner')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_schedules_org_key_unique" ON "payment_schedules" ("org_id", "client_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_schedules_org_idx" ON "payment_schedules" ("org_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_schedules_due_idx" ON "payment_schedules" ("status", "next_due_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_schedule_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "schedule_id" text NOT NULL REFERENCES "payment_schedules"("id"),
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "due_date" text NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "mode" text NOT NULL,
  "ran_as" text,
  "status" text NOT NULL,
  "reason_code" text,
  "reason" text,
  "fallback" boolean DEFAULT false NOT NULL,
  "batch_id" text REFERENCES "wallet_batches"("id"),
  "item_count" integer DEFAULT 0 NOT NULL,
  "total_minor" bigint DEFAULT 0 NOT NULL,
  "fee_minor" bigint DEFAULT 0 NOT NULL,
  "claimed_at" timestamp with time zone,
  "notice_day_before_at" timestamp with time zone,
  "notice_running_at" timestamp with time zone,
  "notice_receipt_at" timestamp with time zone,
  "skipped_by" text,
  "skipped_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_schedule_runs_mode_check" CHECK ("mode" IN ('ask', 'auto')),
  CONSTRAINT "payment_schedule_runs_ran_as_check" CHECK ("ran_as" IS NULL OR "ran_as" IN ('ask', 'auto')),
  CONSTRAINT "payment_schedule_runs_status_check" CHECK ("status" IN ('scheduled', 'waiting_approval', 'approved', 'paid', 'skipped', 'failed', 'lapsed')),
  CONSTRAINT "payment_schedule_runs_due_date_check" CHECK ("due_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_schedule_runs_schedule_due_unique" ON "payment_schedule_runs" ("schedule_id", "due_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_schedule_runs_org_idx" ON "payment_schedule_runs" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_schedule_runs_status_idx" ON "payment_schedule_runs" ("status", "due_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_schedule_runs_batch_idx" ON "payment_schedule_runs" ("batch_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_schedule_run_payments" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL REFERENCES "payment_schedule_runs"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "position" integer NOT NULL,
  "payment_ref" text NOT NULL,
  "recipient_id" text,
  "business_id" text,
  "payee_name" text NOT NULL,
  "address" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "max_fee_minor" bigint NOT NULL,
  "fee_kind" integer NOT NULL,
  "reference" text,
  "status" text NOT NULL,
  "digest" text,
  "gas_budget_mist" bigint DEFAULT 0 NOT NULL,
  "error" text,
  "attempted_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_schedule_run_payments_status_check" CHECK ("status" IN ('pending', 'submitting', 'paid', 'failed')),
  CONSTRAINT "payment_schedule_run_payments_amount_check" CHECK ("amount_minor" > 0 AND "max_fee_minor" >= 0),
  CONSTRAINT "payment_schedule_run_payments_ref_check" CHECK ("payment_ref" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_schedule_run_payments_run_position_unique" ON "payment_schedule_run_payments" ("run_id", "position");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_schedule_run_payments_org_ref_unique" ON "payment_schedule_run_payments" ("org_id", "payment_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_schedule_run_payments_org_idx" ON "payment_schedule_run_payments" ("org_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_payment_settings" (
  "org_id" text PRIMARY KEY NOT NULL REFERENCES "organizations"("id"),
  "auto_paused" boolean DEFAULT false NOT NULL,
  "paused_by" text,
  "paused_at" timestamp with time zone,
  "daily_cap_minor" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scheduled_payment_settings_cap_check" CHECK ("daily_cap_minor" IS NULL OR "daily_cap_minor" > 0)
);
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
  'automatic_payments_paused', 'automatic_payments_resumed', 'automatic_allowance_requested', 'automatic_allowance_revoke_requested'
));
