-- KYB cases, out of a process map and into the database.
--
-- The case record holds a company's registration number, the names and SHA-256
-- of every document they uploaded, the reviewer's notes and the reason they
-- were rejected. Until now it lived in a `globalThis` Map seeded with two
-- invented companies, and every customer-facing read was authenticated but not
-- scoped — so any signed-in user could read any company's case by id, or find
-- one by passing a business name in a query string.
--
-- `org_id` is the fix and it is NOT NULL: a case with no owner cannot be
-- filtered, and a nullable column here would let one row escape every scope.

CREATE TABLE IF NOT EXISTS "kyb_cases" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "business_name" text NOT NULL,
  "registration_number" text NOT NULL,
  "state" text NOT NULL DEFAULT 'SUBMITTED',
  "risk_tier" text NOT NULL DEFAULT 'UNASSIGNED',
  "corridor_access" text NOT NULL DEFAULT 'LOCKED',
  "assigned_to" text,
  "sumsub_applicant_id" text,
  -- Document metadata only. The files themselves are encrypted at rest behind
  -- `storage_key`; putting their contents in a row that half the console can
  -- read would undo that.
  "documents" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "review_notes" text,
  "decision_reason" text,
  "audit_trail" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Every customer-facing read filters by org first.
CREATE INDEX IF NOT EXISTS "kyb_cases_org_idx" ON "kyb_cases" ("org_id");
--> statement-breakpoint
-- The admin console lists by recency across all orgs.
CREATE INDEX IF NOT EXISTS "kyb_cases_updated_idx" ON "kyb_cases" ("updated_at");
--> statement-breakpoint
-- One live case per registration number per org. Two rows for one company mean
-- two review histories, and a decision recorded against whichever one the
-- reviewer happened to open.
CREATE UNIQUE INDEX IF NOT EXISTS "kyb_cases_org_registration_unique"
  ON "kyb_cases" ("org_id", "registration_number");
