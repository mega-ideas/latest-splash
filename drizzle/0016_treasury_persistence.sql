-- The treasury ledger, out of a process map.
--
-- `lib/server/treasury.ts` held every org's Available / Principal / Yield
-- balances in `new Map()`. A restart set every balance back to zero except the
-- demo org's, which was re-seeded — so a deploy could tell a customer their
-- treasury was empty, and a customer who had moved money into Smart Treasury
-- had no record that they had.
--
-- Withdrawal notices lived in an array beside it. Those are worse to lose: a
-- notice is a promise that funds land on a stated date, and settling them is a
-- cron job that reads the array. A restart between request and settlement
-- dropped the obligation silently.

CREATE TABLE IF NOT EXISTS "treasury_ledgers" (
  -- Keyed by ORG. Keyed by anything narrower, tenants share a treasury; keyed
  -- by anything wider, one org's balance is several rows that can disagree.
  "org_id" text PRIMARY KEY NOT NULL REFERENCES "organizations"("id"),
  -- Micro-USD, like every other money column here: integers, never floats.
  "available_micro" bigint DEFAULT 0 NOT NULL,
  "treasury_principal_micro" bigint DEFAULT 0 NOT NULL,
  "treasury_yield_micro" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- A negative balance is not a state this system has. Enforced here rather
  -- than only in the mover, because the mover is not the only writer.
  CONSTRAINT "treasury_ledgers_non_negative" CHECK (
    "available_micro" >= 0
    AND "treasury_principal_micro" >= 0
    AND "treasury_yield_micro" >= 0
  )
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "withdrawal_notices" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "amount_micro" bigint NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- When the funds land back in Available (T+1..T+3).
  "available_at" timestamp with time zone NOT NULL,
  "state" text DEFAULT 'PENDING' NOT NULL,
  CONSTRAINT "withdrawal_notices_positive" CHECK ("amount_micro" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawal_notices_org_idx" ON "withdrawal_notices" ("org_id");
--> statement-breakpoint
-- The settlement cron sweeps by due date and state, across every tenant.
CREATE INDEX IF NOT EXISTS "withdrawal_notices_due_idx"
  ON "withdrawal_notices" ("state", "available_at");
--> statement-breakpoint

-- The accrual baseline.
--
-- Yield is a price DELTA, so accrual needs the previous observation. That
-- baseline was a module-level `let`, so every deploy reset it to null — and a
-- null baseline correctly records nothing, which means a restart silently
-- skipped a day of yield for every customer. One row, because there is one
-- USDY price and it is not per tenant.
CREATE TABLE IF NOT EXISTS "treasury_accrual_state" (
  "id" text PRIMARY KEY NOT NULL,
  "last_accrued_price_micros" bigint,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
