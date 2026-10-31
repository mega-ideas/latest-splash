-- Every on-chain return counted for a withdrawal or supplier payout (v2 §4.4,
-- §4.5), short or whole. Before, only the digest that closed a payout as
-- returned was kept (withdrawals.return_digest), so a short return's digest
-- could be named again for another payout and the same USDC counted twice.
--
-- A digest is the primary key: it counts for one payout only, the first that
-- claims it. A payout's returned amount is the sum of its rows; it closes as
-- returned when the sum is exactly what it sent. The checkpoint is kept so a
-- return can be shown to come after the payout's own deposit.

CREATE TABLE IF NOT EXISTS "withdrawal_returns" (
  "digest" text PRIMARY KEY,
  "withdrawal_id" text NOT NULL REFERENCES "withdrawals"("id"),
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "credited_minor" bigint NOT NULL CHECK ("credited_minor" > 0),
  "checkpoint" bigint NOT NULL,
  "event_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawal_returns_withdrawal_idx" ON "withdrawal_returns" ("withdrawal_id");
--> statement-breakpoint
-- A digest that already closed a payout before this table existed is claimed for it.
INSERT INTO "withdrawal_returns" ("digest", "withdrawal_id", "org_id", "credited_minor", "checkpoint", "event_id", "created_at")
SELECT "return_digest", "id", "org_id", "returned_minor", 0, 'migrated_0043', "updated_at"
FROM "withdrawals"
WHERE "return_digest" IS NOT NULL AND "returned_minor" IS NOT NULL AND "returned_minor" > 0
ON CONFLICT DO NOTHING;
