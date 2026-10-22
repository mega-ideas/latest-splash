-- Sweep jobs and rate holds, out of `operations.ts` and into the database.
--
-- Both lived in `Map`s on `globalThis`. On serverless every instance has its
-- own copy, so state diverged between instances and vanished on cold start: a
-- sweep opened by one instance was unknown to the next, and a customer's rate
-- hold existed or did not depending on which instance answered.
--
-- `org_id` is NOT NULL on both, with a foreign key to `organizations`. Money is
-- integer minor units (`bigint`); rates are exact `numeric`, never float.

CREATE TABLE IF NOT EXISTS "sweep_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "transfer_intent_id" text NOT NULL REFERENCES "payment_intents"("id"),
  "recipient_id" text NOT NULL,
  "partner" text NOT NULL,
  "amount_usdc_micro" bigint NOT NULL CHECK ("amount_usdc_micro" >= 0),
  "target_currency" text NOT NULL,
  "fx_rate" numeric NOT NULL,
  "state" text NOT NULL DEFAULT 'PENDING'
    CHECK ("state" IN ('PENDING', 'EXECUTING', 'COMPLETED', 'FAILED')),
  "held_duration_ms" integer,
  "partner_payout_ref" text,
  "completed_at" timestamp with time zone,
  "demo" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One sweep per transfer. The in-memory code relied on it (a transfer carries a
-- single `sweepJobId`) and never enforced it; a second sweep for one transfer
-- is a second payout of the same money.
CREATE UNIQUE INDEX IF NOT EXISTS "sweep_jobs_transfer_unique" ON "sweep_jobs" ("transfer_intent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sweep_jobs_org_created_idx" ON "sweep_jobs" ("org_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_holds" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "corridor_currency" text NOT NULL,
  "rate" numeric NOT NULL CHECK ("rate" > 0),
  "fee_bps" integer NOT NULL CHECK ("fee_bps" >= 0),
  "hold_until" timestamp with time zone NOT NULL,
  "scheduled_execute_at" timestamp with time zone,
  "alert_rule" jsonb,
  "state" text NOT NULL DEFAULT 'ACTIVE'
    CHECK ("state" IN ('ACTIVE', 'EXECUTED', 'EXPIRED', 'CANCELLED')),
  "transfer_intent_id" text,
  "demo" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Every customer read is one org's holds, newest first.
CREATE INDEX IF NOT EXISTS "rate_holds_org_created_idx" ON "rate_holds" ("org_id", "created_at");
--> statement-breakpoint
-- Expiry sweeps ACTIVE holds whose time has passed.
CREATE INDEX IF NOT EXISTS "rate_holds_active_until_idx" ON "rate_holds" ("state", "hold_until");
