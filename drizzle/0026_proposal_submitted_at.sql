-- When a proposal was handed to the payment route.
--
-- An approved proposal is SUBMITTED, the payment route is replayed with it,
-- and the outcome is recorded on it (execution_state). Those are separate
-- writes. A process that stops between them leaves the proposal SUBMITTED
-- with no outcome: the payment may have gone or not, and nothing shows it.
-- It holds its payment's idempotency key (drizzle/0025) and appears in no
-- queue lane.
--
-- The queue can only tell a payment still being sent from one nobody finished
-- if it knows when it was submitted. The store stamps this on SUBMIT
-- (lib/queue/proposal-state.ts); lib/queue/stuck-payments.ts reads it.
--
-- Run it before the code that ships with it: every proposal write names this
-- column, so until it exists they all fail, and writeFailed then withholds
-- every approval. The pre-deploy migration job runs it first.
ALTER TABLE "proposals" ADD COLUMN "submitted_at" timestamp with time zone;
--> statement-breakpoint
-- Rows already SUBMITTED: the last write to one with no outcome is its
-- SUBMIT, so updated_at is when it was handed over. For one that has an
-- outcome it is an upper bound, and nothing reads it there.
UPDATE "proposals" SET "submitted_at" = "updated_at"
WHERE "status" IN ('SUBMITTED', 'SETTLED', 'ANCHORED', 'REVERSED') AND "submitted_at" IS NULL;
