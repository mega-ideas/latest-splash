-- Persist payout runs, and make them belong to somebody.
--
-- A batch is a payroll run: many recipients paid under one authorization, one
-- settlement digest, one replay key. It lived in a process-global JS Map, so
-- it did not survive a restart — and the record an operator needs most when a
-- run half-completes is the one that vanished on deploy.
--
-- The replay key is the sharper problem. `deriveIdempotencyKey` exists so the
-- common accident — the response leg drops, the dashboard shows "Batch failed",
-- the operator re-submits the same file — does not pay every recipient twice
-- out of the shared pool. That guard was a lookup in a Map. A restart between
-- the two submissions emptied it, and the second run paid everyone again.
--
-- It was scoped by `account_id`, which is not a tenant key: an org with no
-- provisioned on-chain account falls back to a value shared with every other
-- such org, so one tenant's key could match another's run. Scoped by org here,
-- like `payment_intents` and `proposals` already are.

CREATE TABLE "batch_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  -- The on-chain BusinessAccount the run settles from. Recorded, not used for
  -- scoping — see the org_id above and drizzle/0008 for why.
  "account_id" text,
  "state" text NOT NULL,
  "row_count" integer NOT NULL,
  "accepted_rows" integer NOT NULL,
  "blocked_rows" integer NOT NULL,
  -- Minor units, like every other amount here. The Map held a `.toFixed(2)`
  -- string built from a float sum.
  "total_amount_minor" bigint NOT NULL,
  "currency" text DEFAULT 'USD' NOT NULL,
  "target_currency" text,
  "idempotency_key" text NOT NULL,
  "digest" text,
  "package_id" text,
  -- Which proposal authorized this run, when it needed a second approver.
  "proposal_id" text,
  "demo" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "batch_runs" ADD CONSTRAINT "batch_runs_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The replay guard itself. A UNIQUE INDEX rather than a read-then-write: two
-- submissions of the same file arriving together would both find nothing and
-- both insert, which is the exact double payment the key exists to prevent.
CREATE UNIQUE INDEX "batch_runs_idempotency_unique" ON "batch_runs" USING btree ("org_id", "idempotency_key");--> statement-breakpoint

CREATE INDEX "batch_runs_org_created_idx" ON "batch_runs" USING btree ("org_id", "created_at" DESC);
