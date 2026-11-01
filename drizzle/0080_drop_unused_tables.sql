-- Drop six tables that nothing reads and nothing writes (v2 Phase 3, p3-tables).
--
-- Sky's decision: a table that is not used in any situation is dropped. A search
-- of lib, app, components, scripts, tests, the operator console, the cron
-- routes, raw and string-built SQL and the schema found no reader and no writer
-- for these six:
--
--   funding_events    made by 0000 for a funding ledger; funding sessions,
--                     funding sources and funding intents carry that work.
--   treasury_moves    made by 0000 for custodial treasury moves; the custodial
--                     treasury path is retired.
--   compliance_cases  made by 0000 for compliance holds; nothing opens a case.
--   screening_results made by 0000; a recipient's screening verdict lives on
--                     suppliers.screening_verdict.
--   audit_anchors     made by 0000; the daily audit batch is daily_audit_batches
--                     and the anchor itself is the on-chain audit_anchor object.
--   login_attempts    made by 0004; the login limiter has used rate_limit_hits
--                     since WS7 and nothing has written here since.
--
-- No other table has a foreign key to any of them. Their own indexes and their
-- foreign keys to organizations go with them. The screening_verdict type stays:
-- suppliers.screening_verdict uses it.
--
-- Dropping loses the rows. docs/v2/migrations.md gives the row count to read
-- before applying this to a shared database. The earlier migrations that made
-- the tables are not edited. IF EXISTS makes this safe on a database that never
-- had a table, and a second run a no-op. Nothing else is dropped with them.
DROP TABLE IF EXISTS "funding_events";--> statement-breakpoint
DROP TABLE IF EXISTS "treasury_moves";--> statement-breakpoint
DROP TABLE IF EXISTS "compliance_cases";--> statement-breakpoint
DROP TABLE IF EXISTS "screening_results";--> statement-breakpoint
DROP TABLE IF EXISTS "audit_anchors";--> statement-breakpoint
DROP TABLE IF EXISTS "login_attempts";
