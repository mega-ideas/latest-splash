-- Onboarding: persisted terms acceptance, and the workspace's declared intent.
--
-- `intent` is presentation only — it tailors the setup flow and never gates
-- differently from kyb_lifecycle. Backfill: any organisation that has ever
-- created a payment intent is plainly here to pay; everyone else chooses once
-- on first entry.
ALTER TABLE "organizations" ADD COLUMN "intent" text;
--> statement-breakpoint
CREATE TABLE "terms_acceptances" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "version" text NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "terms_acceptances_org_version_idx" ON "terms_acceptances" ("org_id", "version");
--> statement-breakpoint
UPDATE "organizations" SET "intent" = 'pay'
WHERE "intent" IS NULL
  AND EXISTS (SELECT 1 FROM "payment_intents" pi WHERE pi."org_id" = "organizations"."id");
