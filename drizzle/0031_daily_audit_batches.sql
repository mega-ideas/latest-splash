-- Daily audit batches, out of `lib/server/audit-batches.ts` and into the database.
--
-- The batches lived in a `Map` on `globalThis`. The batch existed only on the
-- instance the cron job happened to hit, so the staff console on any other
-- instance had nothing to verify against, and after a cold start the cron found
-- no record of a root already anchored on Sui and built and anchored the same
-- business day a second time.
--
-- No `org_id`, unlike every other WS8 table, and on purpose: a batch spans every
-- tenant (its leaves are many workspaces' transfer ids), so there is no single
-- owner to scope by. The protection is who may read it — the readers are
-- staff-only by name (`*ForStaff`, WS2) and sit behind the staff session.

CREATE TABLE IF NOT EXISTS "daily_audit_batches" (
  "id" text PRIMARY KEY NOT NULL,
  "business_date" date NOT NULL,
  "merkle_root" text NOT NULL,
  "settlement_count" integer NOT NULL CHECK ("settlement_count" > 0),
  "leaves" jsonb NOT NULL,
  "walrus_blob_id" text NOT NULL,
  "walrus_mode" text NOT NULL CHECK ("walrus_mode" IN ('demo', 'live')),
  "seal_policy_id" text NOT NULL,
  "seal_mode" text NOT NULL CHECK ("seal_mode" IN ('demo', 'live')),
  "ciphertext_hash" text NOT NULL,
  "anchor_object_id" text,
  "anchor_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One batch per business date. The map was keyed by date and relied on it; two
-- cron runs for the same day from two instances now keep the first and the
-- second reads it back, rather than recording a second root for the day.
CREATE UNIQUE INDEX IF NOT EXISTS "daily_audit_batches_business_date_unique" ON "daily_audit_batches" ("business_date");
