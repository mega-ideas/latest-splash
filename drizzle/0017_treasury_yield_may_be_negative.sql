-- Accrued yield may be negative. The constraint in 0016 said otherwise.
--
-- USDY accrues through its redemption price, so the day's yield is a price
-- DELTA on units held — and a price can fall. `lib/policy/yield-accrual.ts`
-- returns a negative figure in that case deliberately: "a redemption price that
-- moved down is a real loss on the position, and clamping it at zero would
-- report a floor the instrument does not have."
--
-- Migration 0016 then added `treasury_yield_micro >= 0` to the same table. The
-- two cannot both hold. The consequence is not a rejected row in isolation: the
-- accrual cron loops over every organisation and writes each ledger in turn, so
-- the first org whose accumulated yield went negative aborts the run and every
-- org after it in the loop is silently skipped for that day.
--
-- `available_micro` and `treasury_principal_micro` keep their floor. Those are
-- custodial positions and a negative one is a bug, not a market move — the
-- movers check before writing, and the constraint is the backstop for the
-- writers that are not the movers.

ALTER TABLE "treasury_ledgers" DROP CONSTRAINT IF EXISTS "treasury_ledgers_non_negative";
--> statement-breakpoint
ALTER TABLE "treasury_ledgers" ADD CONSTRAINT "treasury_ledgers_non_negative" CHECK (
  "available_micro" >= 0
  AND "treasury_principal_micro" >= 0
);
