-- Follow-ups on the payout partners (v2 §4.5).
--
-- 1. A failed payout's request for its USDC back is kept, so the sweep asks
--    again until the partner accepts: `return_asks` (how often Splash asked),
--    `return_asked_at` (the last time) and `return_accepted_at` (when the
--    partner accepted; null while the return is still owed). Payouts that
--    failed before this column existed take their answer from the trail.
-- 2. Every new withdrawal row must carry its ISO 20022 purpose code and the
--    masked pacs.008 copy the partner was sent. Rows written before the copy
--    was kept are marked `iso20022_legacy`, so the evidence export can say so
--    plainly instead of showing an empty message. A supplier payout always
--    needed both (withdrawals_kind_check, 0042).
-- 3. `payout_partner_unknown_events`: a correctly signed partner event whose
--    type or status Splash does not know is acknowledged (so the partner does
--    not retry it forever) and kept here for ops to look at and replay: the
--    partner, the event id, the type and status cut short, and how often it
--    came. Nothing else from the body is kept.

ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "return_asks" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "return_asked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "return_accepted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "iso20022_legacy" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "withdrawals" w
SET "return_asks" = e."asks",
    "return_asked_at" = e."last_at",
    "return_accepted_at" = e."accepted_at"
FROM (
  SELECT "subject_id",
         count(*)::integer AS "asks",
         max("created_at") AS "last_at",
         max("created_at") FILTER (WHERE "detail"->>'accepted' = 'true') AS "accepted_at"
  FROM "withdrawal_events"
  WHERE "subject" = 'withdrawal' AND "action" = 'return_requested'
  GROUP BY "subject_id"
) e
WHERE w."id" = e."subject_id";
--> statement-breakpoint
UPDATE "withdrawals" SET "iso20022_legacy" = true
WHERE "kind" = 'withdrawal' AND ("purpose_code" IS NULL OR "iso20022" IS NULL);
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_iso20022_check" CHECK (
  "iso20022_legacy" OR ("purpose_code" IS NOT NULL AND "iso20022" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_return_owed_idx" ON "withdrawals" ("status") WHERE "status" = 'failed' AND "return_accepted_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payout_partner_unknown_events" (
  "partner" text NOT NULL,
  "event_key" text NOT NULL,
  "event_id" text,
  "event_type" text NOT NULL,
  "event_status" text NOT NULL,
  "deliveries" integer DEFAULT 1 NOT NULL,
  "first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_received_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("partner", "event_key")
);
