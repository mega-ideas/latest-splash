-- Governance alerts (v2, brief 3.5): every business owner is told, in the app,
-- by email and on a verified WhatsApp number, when the canonical upgrade
-- wrapper announces a core upgrade or a new governance owner, or the canonical
-- compliance config announces a registry addition.
--
-- No `org_id` on the alert, like `daily_audit_batches`: one announcement
-- concerns every tenant. Who was told, and how, is per person, in
-- `governance_alert_deliveries`.

CREATE TABLE IF NOT EXISTS "governance_alerts" (
  "id" text PRIMARY KEY NOT NULL,
  "digest" text NOT NULL,
  "event_seq" integer NOT NULL CHECK ("event_seq" >= 0),
  "kind" text NOT NULL CHECK ("kind" IN ('upgrade_proposed', 'upgrade_authorized', 'owner_change_proposed', 'registry_addition_proposed', 'registry_addition_activated')),
  "event_type" text NOT NULL,
  "bytecode_digest" text,
  "upgrade_policy" integer,
  "registry" integer CHECK ("registry" IS NULL OR "registry" IN (1, 2, 3)),
  "type_name" text,
  "new_owner" text,
  "proposed_at" timestamp with time zone,
  "eta_at" timestamp with time zone,
  "occurred_at" timestamp with time zone,
  "active_until" timestamp with time zone NOT NULL,
  "summary" text NOT NULL,
  "detail" text NOT NULL,
  "review_path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Sui names an event by its transaction digest and its position in it. Every
-- cron run re-reads recent events; this index is why none is recorded twice.
CREATE UNIQUE INDEX IF NOT EXISTS "governance_alerts_digest_seq_unique" ON "governance_alerts" ("digest", "event_seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "governance_alerts_active_until_idx" ON "governance_alerts" ("active_until");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "governance_alert_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "alert_id" text NOT NULL REFERENCES "governance_alerts"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "channel" text NOT NULL CHECK ("channel" IN ('in_app', 'email', 'whatsapp')),
  "status" text NOT NULL CHECK ("status" IN ('sending', 'sent', 'failed')),
  "attempts" integer DEFAULT 1 NOT NULL CHECK ("attempts" > 0),
  "provider_ref" text,
  "error" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The idempotency: a run claims a delivery by inserting this row before it
-- sends, so a re-run or a second instance cannot send the same alert to the
-- same person on the same channel twice.
CREATE UNIQUE INDEX IF NOT EXISTS "governance_alert_deliveries_alert_user_channel_unique" ON "governance_alert_deliveries" ("alert_id", "user_id", "channel");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "governance_alert_deliveries_user_channel_idx" ON "governance_alert_deliveries" ("user_id", "channel");
