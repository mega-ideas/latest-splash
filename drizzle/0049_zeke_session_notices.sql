-- Zeke's once-per-session notices (v2 §4.8): the read-only limitation
-- statement and the first-recipient nudge. The primary key is the "once":
-- a claim is an insert that lands or conflicts. Rows older than a session's
-- lifetime are pruned as claims are made.

CREATE TABLE IF NOT EXISTS "zeke_session_notices" (
	"org_id" text NOT NULL,
	"session_key" text NOT NULL,
	"notice" text NOT NULL,
	"shown_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zeke_session_notices_org_id_session_key_notice_pk" PRIMARY KEY("org_id","session_key","notice")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zeke_session_notices_shown_at_idx" ON "zeke_session_notices" USING btree ("shown_at");
