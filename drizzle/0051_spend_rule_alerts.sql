-- Near-threshold alerts for spending rules (v2 Phase 2; Phase 1 R5; A1 §6).
-- Detective only: lib/server/near-threshold.ts reads a business's running
-- totals and RuleSpend from the chain and flags one spender paying one
-- recipient again and again just under the second-approval threshold, and
-- several spenders paying one recipient past it together. Nothing here
-- blocks a payment.
--
-- One row per alert per business, unique on (org, content key): every cron
-- run derives the same key from the same totals, and the index is why none
-- is recorded twice. The row is the in-app alert the owners read.

CREATE TABLE IF NOT EXISTS "spend_rule_alerts" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "content_key" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('near_threshold_repeat', 'same_recipient_many_spenders')),
  "severity" text NOT NULL CHECK ("severity" IN ('near_threshold', 'over_threshold')),
  "policy_id" text NOT NULL,
  "recipient" text,
  "beneficiary" text,
  "spenders" jsonb NOT NULL,
  "counted_minor" text NOT NULL CHECK ("counted_minor" ~ '^[0-9]{1,39}$'),
  "threshold_minor" text NOT NULL CHECK ("threshold_minor" ~ '^[0-9]{1,39}$'),
  "payments" integer NOT NULL CHECK ("payments" >= 0),
  "summary" text NOT NULL,
  "detail" text NOT NULL,
  "active_until" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "spend_rule_alerts_target_check" CHECK (("recipient" IS NULL) <> ("beneficiary" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spend_rule_alerts_org_content_key_unique" ON "spend_rule_alerts" ("org_id", "content_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spend_rule_alerts_org_active_idx" ON "spend_rule_alerts" ("org_id", "active_until");
--> statement-breakpoint
-- One owner emailed about one alert. Claimed as `sending` before anything is
-- sent, so a re-run or a second instance cannot send it twice; a failure may
-- be claimed again a bounded number of times.
CREATE TABLE IF NOT EXISTS "spend_rule_alert_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "alert_id" text NOT NULL REFERENCES "spend_rule_alerts"("id"),
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "channel" text NOT NULL CHECK ("channel" IN ('email')),
  "status" text NOT NULL CHECK ("status" IN ('sending', 'sent', 'failed')),
  "attempts" integer DEFAULT 1 NOT NULL CHECK ("attempts" > 0),
  "provider_ref" text,
  "error" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spend_rule_alert_deliveries_alert_user_channel_unique" ON "spend_rule_alert_deliveries" ("alert_id", "user_id", "channel");
