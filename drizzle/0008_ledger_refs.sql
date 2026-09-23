-- Give the journal somewhere honest to put what a movement refers to.
--
-- `lib/ledger/post.ts` is a real double-entry writer — postings that must sum
-- to zero per currency, an invariant query that proves it globally, a test
-- suite, and a paragraph in docs/W1-BACKUPS.md describing it as the record you
-- believe when the state and the money disagree.
--
-- Nothing called it. Every actual money movement went to `createLedgerEntry`,
-- a single-entry append to a Map on `globalThis`, and `getLedgerBalance` — the
-- check that decides whether a payment may leave — summed that map. So the
-- balance a payment was checked against emptied on every restart, and the
-- audited ledger was written by its own test and no one else.
--
-- Wiring the application to `postJournal` needs two facts the journal had
-- nowhere to keep. Without these columns they would have been smuggled through
-- `intent_id` (which means an intent, not a sweep job or a funding session) and
-- `description` (which means prose, not a digest) — the kind of overloading
-- that is invisible until somebody queries on it.

-- 1. What this movement refers to: the sweep job, the funding session, the
--    intent. `kind` already says which of those it is.
ALTER TABLE "journal_entries" ADD COLUMN "ref_id" text;--> statement-breakpoint

-- 2. The settlement digest, where the movement had one. Chain evidence for a
--    ledger line, in its own column, so reconciling the ledger against the
--    chain does not mean parsing a description field.
ALTER TABLE "journal_entries" ADD COLUMN "sui_tx_digest" text;--> statement-breakpoint

-- Reading one account's postings newest-first is what the ledger page and every
-- balance check do. `postings_account_idx` already covers (account, currency);
-- this carries the ordering so the read is an index scan rather than a sort.
CREATE INDEX "postings_account_created_idx" ON "ledger_postings" USING btree ("account", "currency", "created_at" DESC);
