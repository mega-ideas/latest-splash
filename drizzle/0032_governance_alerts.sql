-- Governance alerts (v2, brief 3.5): every business owner is told, in the app,
-- by email and on a verified WhatsApp number, when the canonical upgrade
-- wrapper holds a pending core upgrade or a pending new governance owner, when
-- the canonical compliance config holds a pending registry addition, and when
-- one of those has taken effect. The monitor reads the two objects' state on
-- chain (lib/server/governance-events.ts), not an event feed.
--
-- No `org_id` on the alert, like `daily_audit_batches`: one announcement
-- concerns every tenant. Who was told, and how, is per person, in
-- `governance_alert_deliveries`.

CREATE TABLE IF NOT EXISTS "governance_alerts" (
  "id" text PRIMARY KEY NOT NULL,
  "content_key" text NOT NULL,
  "subject_id" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('upgrade_proposed', 'owner_change_proposed', 'registry_addition_proposed', 'upgrade_committed', 'registry_addition_activated')),
  "bytecode_digest" text,
  "upgrade_policy" integer,
  "package_id" text,
  "package_version" bigint,
  "registry" integer CHECK ("registry" IS NULL OR "registry" IN (1, 2, 3)),
  "type_name" text,
  "new_owner" text,
  "proposed_at" timestamp with time zone,
  "eta_at" timestamp with time zone,
  "active_until" timestamp with time zone NOT NULL,
  "summary" text NOT NULL,
  "detail" text NOT NULL,
  "review_path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- An alert's key is what it says (wrapper + bytecode digest + eta, and so on).
-- Every cron run reads the same state again; this index is why none is
-- recorded twice, by one instance or two.
CREATE UNIQUE INDEX IF NOT EXISTS "governance_alerts_content_key_unique" ON "governance_alerts" ("content_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "governance_alerts_active_until_idx" ON "governance_alerts" ("active_until");
--> statement-breakpoint
-- The last state read of each watched object, at the highest object version
-- seen: what the next run compares with, and which proposals are still
-- pending (a cancelled or lapsed one stops being shown).
CREATE TABLE IF NOT EXISTS "governance_watch_state" (
  "subject_id" text PRIMARY KEY NOT NULL,
  "subject_kind" text NOT NULL CHECK ("subject_kind" IN ('wrapper', 'config')),
  "object_version" bigint NOT NULL CHECK ("object_version" >= 0),
  "snapshot" jsonb NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
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
-- The idempotency: a run claims an email or WhatsApp delivery by writing this
-- row as `sending` before it sends, so a re-run or a second instance cannot
-- send the same alert to the same person on the same channel twice. A claim
-- older than the lease belongs to a run that died and may be taken again; a
-- `sent` row never is.
CREATE UNIQUE INDEX IF NOT EXISTS "governance_alert_deliveries_alert_user_channel_unique" ON "governance_alert_deliveries" ("alert_id", "user_id", "channel");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "governance_alert_deliveries_user_channel_idx" ON "governance_alert_deliveries" ("user_id", "channel");
