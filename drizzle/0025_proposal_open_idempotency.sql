-- One proposal in flight per payment, not one proposal per payment forever.
--
-- A proposal's idempotency key names the payment it is for: the same
-- recipient, amount and currency, the same payroll rows, the same draft Zeke
-- made. It exists so a re-submission finds the proposal already waiting
-- instead of queueing a second one.
--
-- `proposals_idempotency_unique` held the key for as long as the row existed,
-- which is forever. Once the proposal store writes through to Postgres, that
-- turns every finished proposal into a permanent block on its own payment:
--
--   An identical payment proposed again after the first was rejected, had
--   expired, or had been carried out mints a new proposal under the same key.
--   The insert violates the index, the write fails, and the proposal exists
--   only in the memory of one process, where nothing that pays out may act on
--   it. The same payment can never be proposed again.
--
-- The key now binds only while the proposal is in flight. A finished proposal
-- (a terminal status, SETTLED, or an execution outcome recorded against it)
-- gives the key back, and the same payment again is a new attempt with a
-- proposal of its own. Two proposals in flight for one payment are still
-- refused, across processes, which is the case the key is for.
--
-- The predicate mirrors `isProposalInFlight` (lib/queue/proposal-state.ts),
-- which the in-memory store applies to its own key index.
-- tests/proposal-idempotency.test.mjs checks the two agree for every status.
--
-- Safe in either order with the code: the old index allowed no duplicate key
-- at all, so no existing rows can violate this one; old code under the new
-- index only ever re-proposes a key after its proposal finished; new code under
-- the old index sees the insert refused, exactly as before.
DROP INDEX IF EXISTS "proposals_idempotency_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_open_idempotency_unique" ON "proposals" USING btree ("org_id", "idempotency_key")
WHERE "status" NOT IN ('ANCHORED', 'REJECTED', 'FAILED', 'EXPIRED', 'REVERSED', 'SETTLED')
  AND "execution_state" IS NULL;
